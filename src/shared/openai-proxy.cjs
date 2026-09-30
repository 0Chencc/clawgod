'use strict';
// Anthropic Messages API <-> OpenAI Chat Completions API translation proxy
// Allows Claude Code to use xAI/Grok and other OpenAI-compatible APIs

function textParts(content, context) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error(context + ' must be text or content blocks');
  return content.map(function (block) {
    if (block.type !== 'text') throw new Error(context + ': unsupported block ' + block.type);
    return textValue(block.text);
  }).join('\n');
}

function textValue(value) {
  if (typeof value !== 'string') throw new Error('Text content must be a string');
  return value;
}

function userPart(block) {
  if (block.type === 'text') return { type: 'text', text: textValue(block.text) };
  var source = block.source || {};
  if (block.type === 'image') {
    if (source.type === 'base64' && source.data && /^image\//.test(source.media_type))
      return { type: 'image_url', image_url: { url: 'data:' + source.media_type + ';base64,' + source.data } };
    if (source.type === 'url' && source.url) return { type: 'image_url', image_url: { url: source.url } };
    throw new Error('Unsupported image source');
  }
  if (block.type === 'document') {
    if (block.citations && block.citations.enabled) throw new Error('Document citations are not supported by openai-chat');
    if (source.type === 'text') return { type: 'text', text: textValue(source.data) };
    if (source.type === 'base64' && source.media_type === 'application/pdf' && source.data)
      return { type: 'file', file: { filename: block.title || 'document.pdf', file_data: 'data:application/pdf;base64,' + source.data } };
    throw new Error('Unsupported document source; use base64 PDF (requires upstream file support) or text');
  }
  throw new Error('Unsupported user content block: ' + block.type);
}

function translateMessages(msgs) {
  if (!Array.isArray(msgs)) throw new Error('messages must be an array');
  var out = [];
  for (var msg of msgs) {
    // Some clients supply system instructions inside the conversation rather
    // than only in body.system. Chat Completions supports these directly;
    // retain their position and never silently discard instruction content.
    if (msg.role === 'system') {
      out.push({ role: 'system', content: textParts(msg.content, 'System message') });
      continue;
    }
    if (msg.role !== 'user' && msg.role !== 'assistant') throw new Error('Unsupported message role: ' + msg.role);
    if (typeof msg.content === 'string') { out.push({ role: msg.role, content: msg.content }); continue; }
    if (!Array.isArray(msg.content)) throw new Error('Message content must be text or content blocks');
    if (msg.role === 'user') {
      var parts = [];
      for (var block of msg.content) {
        if (block.type === 'tool_result') {
          var text = block.content === undefined ? '' : textParts(block.content, 'Tool result');
          out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: (block.is_error ? '[ERROR] ' : '') + text });
        } else parts.push(userPart(block));
      }
      // All tool results must precede the next user turn (including parallel calls).
      if (parts.length) out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    } else {
      var textContent = '', toolCalls = [];
      for (var b of msg.content) {
        if (b.type === 'text') textContent += textValue(b.text);
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input) } });
        // Anthropic thinking signatures cannot be replayed to Chat Completions.
        else if (b.type !== 'thinking' && b.type !== 'redacted_thinking') throw new Error('Unsupported assistant content block: ' + b.type);
      }
      var assistantMsg = { role: 'assistant', content: textContent || null };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
    }
  }
  return out;
}

function translateRequest(body, configuredEffort) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request must be an object');
  var messages = body.system ? [{ role: 'system', content: textParts(body.system, 'System prompt') }] : [];
  var result = { model: body.model, messages: messages.concat(translateMessages(body.messages || [])), stream: !!body.stream };
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences) result.stop = body.stop_sequences;
  var effort = configuredEffort || (body.output_config && body.output_config.effort);
  if (effort && effort !== 'auto') result.reasoning_effort = effort === 'max' ? 'xhigh' : effort;
  if (body.tools && body.tools.length) result.tools = body.tools.map(function (tool) {
    if (tool.type && tool.type !== 'custom') throw new Error('Unsupported tool type: ' + tool.type);
    return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.input_schema || { type: 'object', properties: {} } } };
  });
  if (body.tool_choice) {
    var choice = body.tool_choice;
    if (choice.type === 'tool' && choice.name) result.tool_choice = { type: 'function', function: { name: choice.name } };
    else if (choice.type === 'any') result.tool_choice = 'required';
    else if (choice.type === 'auto' || choice.type === 'none') result.tool_choice = choice.type;
    else throw new Error('Unsupported tool_choice');
    if (choice.disable_parallel_tool_use !== undefined) result.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  if (body.output_config && body.output_config.format) throw new Error('Structured output format is not supported by openai-chat');
  if (body.stream) result.stream_options = { include_usage: true };
  // Build only protocol fields; never recursively strip keys from user tool data/schema.
  return result;
}

// Deliberately local and approximate: text UTF-8 bytes / 3, image budget 1600,
// PDF decoded bytes / 3. Binary size is not a tokenizer or a PDF page count.
function estimateTokens(request) {
  var bytes = 0, mediaTokens = 0;
  function visit(value) {
    if (typeof value === 'string') bytes += new TextEncoder().encode(value).length;
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if (value.type === 'image_url' && value.image_url) { mediaTokens += 1600; return; }
      if (value.type === 'file' && value.file && typeof value.file.file_data === 'string' && value.file.file_data.startsWith('data:application/pdf;base64,')) {
        mediaTokens += Math.ceil(value.file.file_data.split(',')[1].length / 4); return;
      }
      for (var key of Object.keys(value)) { bytes += key.length; visit(value[key]); }
    }
  }
  visit(request.messages);
  visit(request.tools);
  return Math.max(1, Math.ceil(bytes / 3) + mediaTokens + request.messages.length * 4);
}

function mapFinishReason(reason, hasToolCalls) {
  // Some compatible providers use stop even when they return tool_calls.
  // Keep truncation/refusal distinct, but do not hide a completed tool turn.
  if (reason === 'tool_calls' || (reason === 'stop' && hasToolCalls)) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  // Chat's stop does not distinguish natural stops from stop sequences.
  if (reason === 'stop') return 'end_turn';
  throw new Error('Unsupported upstream finish_reason: ' + reason);
}

function toolInput(argumentsText) {
  var input = JSON.parse(argumentsText || '{}');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool arguments must be a JSON object');
  return input;
}

function usageOf(usage) {
  return { input_tokens: (usage && usage.prompt_tokens) || 0, output_tokens: (usage && usage.completion_tokens) || 0 };
}

function translateResponse(response, model) {
  if (response.error) throw new Error(response.error.message || 'Upstream API error');
  var choice = response.choices && response.choices[0];
  if (!choice || !choice.message || typeof choice.message !== 'object') throw new Error('No message in upstream response');
  var content = [], message = choice.message;
  if (message.content !== undefined && message.content !== null) content.push({ type: 'text', text: textValue(message.content) });
  if (message.refusal) content.push({ type: 'text', text: textValue(message.refusal) });
  for (var tc of message.tool_calls || []) {
    if (!tc.id || !tc.function || !tc.function.name) throw new Error('Incomplete upstream tool call');
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: toolInput(tc.function.arguments) });
  }
  return { id: response.id || ('msg_' + Date.now()), type: 'message', role: 'assistant', content: content, model: model || response.model, stop_reason: mapFinishReason(choice.finish_reason, content.some(function (b) { return b.type === 'tool_use'; })), stop_sequence: null, usage: usageOf(response.usage) };
}

function sse(event, data) { return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'; }

function createStreamTranslator(model) {
  var started = false, finished = false, stopped = false, textIndex = null, nextIndex = 0;
  var tools = new Map(), usage = usageOf(), reason;
  return function (chunk) {
    if (stopped) throw new Error('Data after stream end');
    var events = [];
    function emit(type, fields) { events.push(sse(type, { type: type, ...fields })); }
    if (chunk === null) {
      if (!finished) throw new Error('Upstream stream ended before finish_reason');
      stopped = true;
      emit('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: usage });
      emit('message_stop', {});
      return events;
    }
    if (chunk.error) throw new Error(chunk.error.message || 'Upstream stream error');
    if (chunk.usage) usage = usageOf(chunk.usage);
    var choice = chunk.choices && chunk.choices.find(function (c) { return c.index === undefined || c.index === 0; });
    if (!choice) {
      if (!Array.isArray(chunk.choices)) throw new Error('Invalid upstream stream chunk');
      return events;
    }
    if (finished) throw new Error('Completion data after finish_reason');
    if (!started) {
      started = true;
      emit('message_start', { message: { id: chunk.id || ('msg_' + Date.now()), type: 'message', role: 'assistant', content: [], model: model || chunk.model, stop_reason: null, stop_sequence: null, usage: usage } });
    }
    var delta = choice.delta || {};
    var text = delta.content || delta.refusal;
    if (text) {
      textValue(text);
      if (textIndex === null) { textIndex = nextIndex++; emit('content_block_start', { index: textIndex, content_block: { type: 'text', text: '' } }); }
      emit('content_block_delta', { index: textIndex, delta: { type: 'text_delta', text: text } });
    }
    for (var tc of delta.tool_calls || []) {
      if (!Number.isInteger(tc.index) || tc.index < 0) throw new Error('Invalid upstream tool index');
      if (!tools.has(tc.index)) tools.set(tc.index, { id: '', name: '', args: '' });
      var buf = tools.get(tc.index);
      if (tc.id) buf.id += tc.id;
      if (tc.function) { buf.name += tc.function.name || ''; buf.args += tc.function.arguments || ''; }
    }
    if (choice.finish_reason) {
      reason = mapFinishReason(choice.finish_reason, tools.size > 0);
      if (textIndex !== null) emit('content_block_stop', { index: textIndex });
      // Buffer tools until complete so fragmented metadata and parallel calls
      // produce valid, sequential Anthropic content blocks with validated JSON.
      for (var tool of tools.values()) {
        if (!tool.id || !tool.name) throw new Error('Incomplete upstream tool call');
        toolInput(tool.args);
        var index = nextIndex++;
        emit('content_block_start', { index: index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
        emit('content_block_delta', { index: index, delta: { type: 'input_json_delta', partial_json: tool.args || '{}' } });
        emit('content_block_stop', { index: index });
      }
      finished = true;
    }
    return events;
  };
}

// Parse complete SSE events, independent of transport chunk / UTF-8 boundaries.
async function* translateStream(reader, model) {
  var decoder = new TextDecoder(), buffer = '', data = [], translate = createStreamTranslator(model);
  function payload(line) {
    if (line === '') { var result = data.length ? data.join('\n') : undefined; data = []; return result; }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  while (true) {
    var read = await reader.read();
    buffer += read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });
    if (read.done && buffer && !/[\r\n]$/.test(buffer)) buffer += '\n';
    var match;
    while ((match = /[\r\n]/.exec(buffer))) {
      var offset = match.index;
      if (!read.done && buffer[offset] === '\r' && offset === buffer.length - 1) break;
      var line = buffer.slice(0, offset);
      buffer = buffer.slice(offset + (buffer.slice(offset, offset + 2) === '\r\n' ? 2 : 1));
      var value = payload(line);
      if (value === undefined) continue;
      if (value === '[DONE]') { yield* translate(null); return; }
      yield* translate(JSON.parse(value));
    }
    if (read.done) {
      if (data.length) {
        var tail = data.join('\n');
        if (tail !== '[DONE]') yield* translate(JSON.parse(tail));
      }
      yield* translate(null);
      return;
    }
  }
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', ...headers } });
}
function errorResponse(status, message) {
  var types = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error' };
  return json({ type: 'error', error: { type: types[status] || 'api_error', message: message } }, status);
}

function startProxy(config) {
  var upstreamURL = new URL(config.baseURL || 'https://api.x.ai/v1');
  if (!['http:', 'https:'].includes(upstreamURL.protocol) || upstreamURL.username || upstreamURL.password || upstreamURL.search || upstreamURL.hash)
    throw new Error('OpenAI baseURL must be an HTTP(S) API base without credentials, query, or fragment');
  upstreamURL.pathname = upstreamURL.pathname.replace(/\/+$/, '') + '/chat/completions';
  var server = Bun.serve({
    port: 0, hostname: '127.0.0.1', idleTimeout: 255,
    fetch: async function (req) {
      var path = new URL(req.url).pathname;
      if (req.method === 'GET' && path === '/health') return new Response('ok');
      var count = path === '/v1/messages/count_tokens' || path === '/messages/count_tokens';
      if (req.method !== 'POST' || (!count && path !== '/v1/messages' && path !== '/messages')) return errorResponse(404, 'Not found');
      var body, request;
      try {
        body = await req.json();
        request = translateRequest(body, config.effort);
        request.model = body.model || config.model || '';
      } catch (e) { return errorResponse(400, 'Translation error: ' + e.message); }
      if (count) return json({ input_tokens: estimateTokens(request) }, 200, { 'x-clawgod-token-count': 'estimate' });

      var abort = new AbortController();
      var onAbort = function () { abort.abort(req.signal.reason); };
      req.signal.addEventListener('abort', onAbort, { once: true });
      if (req.signal.aborted) onAbort();
      var timeout = Number(config.timeoutMs) || 3000000;
      var timer = setTimeout(function () { abort.abort(new Error('Upstream request timed out')); }, timeout);
      if (timer.unref) timer.unref();
      function cleanup() { clearTimeout(timer); req.signal.removeEventListener('abort', onAbort); }
      var upstream;
      try {
        upstream = await fetch(upstreamURL.href, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey }, body: JSON.stringify(request), signal: abort.signal });
        if (!upstream.ok) {
          var errText = await upstream.text(), errBody;
          try { errBody = JSON.parse(errText); } catch {}
          var response = errorResponse(upstream.status, (errBody && errBody.error && errBody.error.message) || errText || ('HTTP ' + upstream.status));
          var retryAfter = upstream.headers.get('retry-after');
          if (retryAfter) response.headers.set('retry-after', retryAfter);
          cleanup();
          return response;
        }
        if (!request.stream) {
          var result = translateResponse(await upstream.json(), request.model);
          cleanup();
          return json(result);
        }
        if (!upstream.body || !(upstream.headers.get('content-type') || '').toLowerCase().startsWith('text/event-stream'))
          throw new Error('Expected an upstream text/event-stream response');
      } catch (e) {
        abort.abort();
        cleanup();
        return errorResponse(502, 'Upstream request failed: ' + e.message);
      }

      var reader = upstream.body.getReader(), iterator = translateStream(reader, request.model), cancelled = false;
      var encoder = new TextEncoder();
      async function closeReader() { try { await reader.cancel(); } catch {} cleanup(); }
      var readable = new ReadableStream({
        async pull(controller) {
          try {
            var next = await iterator.next();
            if (cancelled) return;
            if (next.done) { await closeReader(); controller.close(); }
            else controller.enqueue(encoder.encode(next.value));
          } catch (e) {
            if (!cancelled) {
              controller.enqueue(encoder.encode(sse('error', { type: 'error', error: { type: 'api_error', message: 'Stream error: ' + e.message } })));
              controller.close();
            }
            abort.abort();
            await closeReader();
          }
        },
        async cancel() { cancelled = true; abort.abort(); await closeReader(); await iterator.return(); },
      });
      return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    },
  });
  return { port: server.port, stop: function () { server.stop(); } };
}

module.exports = { startProxy: startProxy };
