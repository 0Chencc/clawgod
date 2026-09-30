import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('./openai-proxy.cjs', import.meta.url), 'utf8');
const success = (extra = {}) => ({ id: 'chat-fixture', model: 'upstream-model', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 123, completion_tokens: 7 }, ...extra });
const jsonResponse = (body = success(), options) => new Response(JSON.stringify(body), options);
const chunk = (delta = {}, finish_reason = null) => ({ id: 'chat-fixture', choices: [{ index: 0, delta, finish_reason }] });
const usageChunk = { choices: [], usage: { prompt_tokens: 123, completion_tokens: 7 } };
const encodeEvents = (chunks, done = true) => chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
function streamResponse(text, byteSize = Infinity, onCancel = () => {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + byteSize));
      offset += byteSize;
    },
    cancel: onCancel,
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
function setup(upstream = () => jsonResponse(), config = {}) {
  let handler, stopped = false;
  const calls = [], module = { exports: {} };
  runInNewContext(source, {
    module, URL, Response, ReadableStream, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout,
    Bun: { serve(options) { handler = options.fetch; return { port: 12345, stop() { stopped = true; } }; } },
    async fetch(url, options) { calls.push({ url, ...options, body: JSON.parse(options.body) }); return upstream(options); },
  });
  const proxy = module.exports.startProxy({ baseURL: 'https://upstream.invalid/v1/', apiKey: 'test-key', model: 'fallback-model', ...config });
  return {
    calls, proxy, isStopped: () => stopped,
    send(body = {}, path = '/v1/messages', options = {}) {
      return handler(new Request('http://127.0.0.1:12345' + path, {
        method: 'POST', body: JSON.stringify({ model: 'custom-model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 100, ...body }), ...options,
      }));
    },
  };
}
async function readEvents(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const text = await response.text();
  return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}
function checkLifecycle(events) {
  assert.equal(events[0].type, 'message_start');
  assert.equal(events.filter(e => e.type === 'message_start').length, 1);
  assert.equal(events.at(-2).type, 'message_delta');
  assert.equal(events.at(-1).type, 'message_stop');
  assert.equal(events.filter(e => e.type === 'message_stop').length, 1);
  let active = null, nextIndex = 0;
  for (const event of events) {
    if (event.type === 'content_block_start') {
      assert.equal(active, null);
      assert.equal(event.index, nextIndex++);
      active = event.index;
    } else if (event.type === 'content_block_delta') assert.equal(event.index, active);
    else if (event.type === 'content_block_stop') { assert.equal(event.index, active); active = null; }
  }
  assert.equal(active, null);
}

test('request translation preserves conversation, parallel tool results and user schema/data', async () => {
  const p = setup();
  const toolData = { cache_control: 'actual user data', nested: { cache_control: 'keep' } };
  const schema = { type: 'object', properties: { cache_control: { type: 'string' } }, required: ['cache_control'] };
  const r = await p.send({
    system: [{ type: 'text', text: 'first', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'second' }],
    messages: [
      { role: 'user', content: 'run tools' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'private', signature: 'opaque' }, { type: 'text', text: 'running' }, { type: 'tool_use', id: 'a', name: 'one', input: toolData }, { type: 'tool_use', id: 'b', name: 'two', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }, { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'output' }] }, { type: 'tool_result', tool_use_id: 'b', content: 'failed', is_error: true }] },
    ],
    tools: [{ name: 'one', description: 'a tool', input_schema: schema, cache_control: { type: 'ephemeral' } }],
    temperature: 0, top_p: 0.9, stop_sequences: ['END'],
  });
  assert.equal(r.status, 200);
  const call = p.calls[0], body = call.body;
  assert.equal(call.url, 'https://upstream.invalid/v1/chat/completions');
  assert.equal(call.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(body.messages[0].content, 'first\nsecond');
  assert.equal(body.messages[2].content, 'running');
  assert.deepEqual(JSON.parse(body.messages[2].tool_calls[0].function.arguments), toolData);
  assert.deepEqual(body.tools[0].function.parameters, schema);
  assert.equal(body.messages[3].tool_call_id, 'a');
  assert.equal(body.messages[4].content, '[ERROR] failed');
  assert.equal(body.messages[5].content, 'continue');
  assert.deepEqual([body.temperature, body.top_p, body.stop], [0, 0.9, ['END']]);
  assert.equal(body.messages[0].cache_control, undefined);
  assert.equal(body.tools[0].cache_control, undefined);
});

test('tool_choice and parallel constraints map without changing omitted defaults', async () => {
  for (const [type, expected] of [['auto', 'auto'], ['any', 'required'], ['none', 'none'], ['tool', { type: 'function', function: { name: 'run' } }]]) {
    for (const disable of [true, false, undefined]) {
      const p = setup();
      await p.send({ tool_choice: { type, name: 'run', disable_parallel_tool_use: disable } });
      assert.deepEqual(p.calls[0].body.tool_choice, expected);
      assert.equal(p.calls[0].body.parallel_tool_calls, disable === undefined ? undefined : !disable);
    }
  }
  const p = setup();
  await p.send();
  assert.equal(p.calls[0].body.tool_choice, undefined);
});

test('base64/URL images, PDF files and text documents retain their content', async () => {
  const p = setup();
  await p.send({ messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    { type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } },
    { type: 'document', title: 'manual.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' } },
    { type: 'document', source: { type: 'text', data: 'document text' } },
  ] }] });
  assert.deepEqual(p.calls[0].body.messages[0].content, [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } },
    { type: 'file', file: { filename: 'manual.pdf', file_data: 'data:application/pdf;base64,JVBERg==' } },
    { type: 'text', text: 'document text' },
  ]);
});

test('unsupported attachments, citations, tools and malformed requests fail before fetch', async () => {
  for (const fields of [
    { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://example.invalid/a.pdf' } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'document', citations: { enabled: true }, source: { type: 'text', data: 'text' } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file' } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'audio' }] }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'image' }] }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'server_tool_use' }] }] },
    { messages: [{ role: 'unknown', content: 'text' }] },
    { messages: [{ role: 'user', content: 7 }] },
    { messages: [{ role: 'user', content: [{ type: 'text' }] }] },
    { messages: 'invalid' }, { system: [{ type: 'image' }] },
    { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    { tool_choice: { type: 'bad' } }, { output_config: { format: { type: 'json_schema' } } },
  ]) {
    const p = setup();
    const r = await p.send(fields);
    assert.equal(r.status, 400, JSON.stringify(fields));
    assert.equal((await r.json()).error.type, 'invalid_request_error');
    assert.equal(p.calls.length, 0);
  }
  for (const body of ['{', 'null', '[]']) {
    const p = setup();
    assert.equal((await p.send({}, '/v1/messages', { body })).status, 400);
    assert.equal(p.calls.length, 0);
  }
});

test('count_tokens is local, deterministic, includes system/tools/media and excludes output budget', async () => {
  const p = setup(() => { throw new Error('must not call upstream'); });
  async function count(fields = {}) {
    const r = await p.send(fields, '/v1/messages/count_tokens');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-clawgod-token-count'), 'estimate');
    const n = (await r.json()).input_tokens;
    assert.ok(Number.isInteger(n) && n > 0);
    return n;
  }
  const baseline = await count();
  assert.equal(await count({ max_tokens: 10000 }), baseline);
  assert.equal(await count(), baseline);
  assert.ok(await count({ system: 'a'.repeat(1000) }) > baseline);
  assert.ok(await count({ messages: [{ role: 'user', content: '你好'.repeat(100) }] }) > baseline);
  assert.ok(await count({ tools: [{ name: 'run', input_schema: { type: 'object', properties: { parameter: { type: 'string' } } } }] }) > baseline);
  // Schema/business fields named like media must not be interpreted as attachments.
  assert.ok(await count({ tools: [{ name: 'run', input_schema: { type: 'object', properties: { type: { const: 'file' } }, examples: [{ type: 'file' }] } }] }) > baseline);
  for (const block of [
    { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA'.repeat(500) } },
  ]) assert.ok(await count({ messages: [{ role: 'user', content: [block] }] }) > baseline);
  assert.equal(p.calls.length, 0);
});

test('non-stream text, tool JSON, refusal, usage, model fallback and finish reasons', async () => {
  for (const [reason, expected] of [['stop', 'end_turn'], ['length', 'max_tokens'], ['tool_calls', 'tool_use'], ['content_filter', 'refusal']]) {
    const p = setup(() => jsonResponse(success({ choices: [{ message: { content: 'text', tool_calls: [{ id: 'call-1', function: { name: 'run', arguments: '{"x":1}' } }] }, finish_reason: reason }] })));
    const result = await (await p.send({ model: '' })).json();
    assert.equal(p.calls[0].body.model, 'fallback-model');
    assert.equal(result.model, 'fallback-model');
    assert.equal(result.stop_reason, expected);
    assert.equal(result.stop_sequence, null);
    assert.deepEqual(result.usage, { input_tokens: 123, output_tokens: 7 });
    assert.deepEqual(result.content[1], { type: 'tool_use', id: 'call-1', name: 'run', input: { x: 1 } });
  }
  const p = setup(() => jsonResponse(success({ choices: [{ message: { content: null, refusal: 'cannot comply' }, finish_reason: 'stop' }] })));
  assert.equal((await (await p.send()).json()).content[0].text, 'cannot comply');
});

test('malformed non-stream responses never become successful fabricated text/tool calls', async () => {
  for (const body of [
    {}, { choices: [] }, { error: { message: 'provider failure' } },
    success({ choices: [{ message: 'invalid', finish_reason: 'stop' }] }),
    success({ choices: [{ message: { content: [{ type: 'text', text: 'invalid' }] }, finish_reason: 'stop' }] }),
    success({ choices: [{ message: { content: 'ok' }, finish_reason: 'unknown' }] }),
    ...['{', '[]', 'null', '42'].map(argumentsText => success({ choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'run', arguments: argumentsText } }] }, finish_reason: 'tool_calls' }] })),
    success({ choices: [{ message: { tool_calls: [{ function: { name: 'run', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
  ]) {
    const p = setup(() => jsonResponse(body));
    assert.equal((await p.send()).status, 502);
  }
  assert.equal((await setup(() => new Response('bad json')).send()).status, 502);
});

test('upstream HTTP errors preserve status/message/retry-after for both streaming modes', async () => {
  for (const stream of [false, true]) for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    const p = setup(() => jsonResponse({ error: { message: 'provider error' } }, { status, headers: { 'retry-after': '3' } }));
    const r = await p.send({ stream });
    assert.equal(r.status, status);
    assert.equal(r.headers.get('retry-after'), '3');
    const result = await r.json();
    assert.equal(result.type, 'error');
    assert.equal(result.error.message, 'provider error');
    if (status === 429) assert.equal(result.error.type, 'rate_limit_error');
  }
  const r = await setup(() => new Response('bad gateway', { status: 502 })).send({ stream: true });
  assert.equal((await r.json()).error.message, 'bad gateway');
  assert.equal((await setup(() => { throw new Error('offline'); }).send()).status, 502);
});

test('SSE usage trailer arrives before the single final message_delta/message_stop', async () => {
  for (const size of [1, 7, Infinity]) for (const done of [true, false]) {
    const p = setup(() => streamResponse(encodeEvents([chunk({ role: 'assistant' }), chunk({ content: '你好🙂' }), chunk({}, 'stop'), usageChunk], done), size));
    const events = await readEvents(await p.send({ stream: true }));
    checkLifecycle(events);
    assert.equal(events.find(e => e.type === 'content_block_delta').delta.text, '你好🙂');
    assert.deepEqual(events.at(-2).usage, { input_tokens: 123, output_tokens: 7 });
    assert.equal(p.calls[0].body.stream_options.include_usage, true);
  }
});

test('SSE accepts CRLF, bare CR, no-space data, comments, multiline JSON and unterminated final event', async () => {
  for (const newline of ['\r\n', '\r', '\n']) {
    const event = 'data:' + JSON.stringify(chunk({ content: 'ok' })).replace(',"choices"', newline + 'data:,"choices"') + newline + newline;
    const wire = ':heartbeat' + newline + newline + event + 'data:' + JSON.stringify(chunk({}, 'stop')) + newline + newline + 'data:[DONE]';
    const p = setup(() => streamResponse(wire, 1));
    checkLifecycle(await readEvents(await p.send({ stream: true })));
  }
});

test('SSE handles empty completion, missing usage, inline usage and all supported finish reasons', async () => {
  for (const [reason, expected] of [['stop', 'end_turn'], ['length', 'max_tokens'], ['content_filter', 'refusal']]) {
    for (const inline of [false, true]) {
      const final = chunk({}, reason);
      if (inline) final.usage = usageChunk.usage;
      const p = setup(() => streamResponse(encodeEvents([final])));
      const events = await readEvents(await p.send({ stream: true }));
      checkLifecycle(events);
      assert.equal(events.at(-2).delta.stop_reason, expected);
      assert.deepEqual(events.at(-2).usage, inline ? { input_tokens: 123, output_tokens: 7 } : { input_tokens: 0, output_tokens: 0 });
    }
  }
});

test('SSE reassembles interleaved parallel tool arguments and fragmented metadata', async () => {
  const chunks = [
    chunk({ content: 'running' }),
    chunk({ tool_calls: [{ index: 1, id: 'call-', function: { name: 'sec', arguments: '{"b":' } }, { index: 0, id: 'first', function: { name: 'first', arguments: '{"a":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, id: 'second', function: { name: 'ond', arguments: '2}' } }] }),
    chunk({}, 'tool_calls'), usageChunk,
  ];
  const events = await readEvents(await setup(() => streamResponse(encodeEvents(chunks), 3)).send({ stream: true }));
  checkLifecycle(events);
  const starts = events.filter(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
  assert.deepEqual(starts.map(e => [e.content_block.id, e.content_block.name]), [['call-second', 'second'], ['first', 'first']]);
  const args = events.filter(e => e.delta?.type === 'input_json_delta').map(e => JSON.parse(e.delta.partial_json));
  assert.deepEqual(args, [{ b: 2 }, { a: 1 }]);
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
});

test('SSE malformed/truncated/error streams emit error without success completion', async () => {
  const cases = [
    '', 'data: not-json\n\n', 'data: [DONE]\n\n',
    encodeEvents([chunk({ content: 'partial' })], false),
    encodeEvents([chunk({ content: 'partial' }), { error: { message: 'stream failed' } }]),
    encodeEvents([chunk({}, 'bad-reason')]),
    encodeEvents([chunk({ content: { invalid: true } }), chunk({}, 'stop')]),
    encodeEvents([chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }), chunk({}, 'tool_calls')]),
    encodeEvents([chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'run', arguments: '{' } }] }), chunk({}, 'tool_calls')]),
    encodeEvents([chunk({ tool_calls: [{ index: -1 }] })]),
    encodeEvents([chunk({}, 'stop'), chunk({ content: 'late' })]),
  ];
  for (const wire of cases) {
    const events = await readEvents(await setup(() => streamResponse(wire)).send({ stream: true }));
    assert.equal(events.at(-1).type, 'error', wire);
    assert.ok(!events.some(e => e.type === 'message_stop'), wire);
  }
  const p = setup(() => new Response(new ReadableStream({ pull(c) { c.error(new Error('socket closed')); } }), { headers: { 'content-type': 'text/event-stream' } }));
  const events = await readEvents(await p.send({ stream: true }));
  assert.match(events.at(-1).error.message, /socket closed/);
});

test('streaming rejects HTTP 200 JSON instead of returning an empty successful stream', async () => {
  assert.equal((await setup().send({ stream: true })).status, 502);
});

test('text is delivered before upstream finishes and downstream cancellation aborts upstream', async () => {
  let controller, cancelled = false;
  const p = setup(() => new Response(new ReadableStream({
    start(c) { controller = c; }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const response = await p.send({ stream: true });
  const reader = response.body.getReader();
  controller.enqueue(new TextEncoder().encode(encodeEvents([chunk({ content: 'early' })], false)));
  let seen = '';
  while (!seen.includes('early')) seen += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!seen.includes('message_stop'));
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(p.calls[0].signal.aborted, true);
});

test('client abort and timeout propagate to fetch; timeout also spans response streaming', async () => {
  function waitForAbort(options) {
    return new Promise((_, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  }
  const client = new AbortController(), p = setup(waitForAbort);
  const pending = p.send({}, '/v1/messages', { signal: client.signal });
  client.abort(new Error('client left'));
  assert.equal((await pending).status, 502);
  assert.equal(p.calls[0].signal.aborted, true);
  // Keep the test process alive while the production timer is unref'ed.
  const hold = setTimeout(() => {}, 2000);
  try {
    const timeout = setup(waitForAbort, { timeoutMs: 10 });
    assert.equal((await timeout.send()).status, 502);
    assert.equal(timeout.calls[0].signal.aborted, true);
    const streaming = setup(options => new Response(new ReadableStream({
      start(c) { options.signal.addEventListener('abort', () => c.error(new Error('timed out')), { once: true }); },
    }), { headers: { 'content-type': 'text/event-stream' } }), { timeoutMs: 10 });
    const events = await readEvents(await streaming.send({ stream: true }));
    assert.equal(events.at(-1).type, 'error');
    assert.match(events.at(-1).error.message, /timed out/);
  } finally { clearTimeout(hold); }
});

test('exact routes, base paths and proxy lifecycle', async () => {
  const p = setup(undefined, { baseURL: 'https://upstream.invalid/custom/v1///' });
  assert.equal((await p.send({}, '/anything/messages')).status, 404);
  assert.equal((await p.send({}, '/v1/messages', { method: 'GET', body: undefined })).status, 404);
  assert.equal((await p.send({}, '/health', { method: 'GET', body: undefined })).status, 200);
  await p.send({}, '/messages');
  assert.equal(p.calls[0].url, 'https://upstream.invalid/custom/v1/chat/completions');
  assert.equal((await p.send({}, '/messages/count_tokens')).status, 200);
  p.proxy.stop();
  assert.equal(p.isStopped(), true);
  for (const baseURL of ['ftp://example.invalid', 'https://user:pass@example.invalid/v1', 'https://example.invalid/v1?key=x', 'https://example.invalid/v1#fragment'])
    assert.throws(() => setup(undefined, { baseURL }), /baseURL/);
});
