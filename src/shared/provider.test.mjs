import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const launcher = read('./cli.cjs');
const proxy = read('./openai-proxy.cjs');
const home = fs.mkdtempSync(join(tmpdir(), 'clawgod-provider-test-'));
const dir = join(home, '.clawgod');
fs.mkdirSync(dir);

// Run the real launcher and proxy handler; only HOME, Bun's listener, the
// final Claude bundle, and upstream HTTP transport are replaced.
function launch(config = {}, env = {}) {
  fs.writeFileSync(join(dir, 'provider.json'), JSON.stringify(config));
  let handler, loaded = false;
  const requests = [];
  const proc = {
    argv: ['node', 'cli.cjs'], env: { ...env }, execPath: '/test/bun',
    stderr: { write() {} }, on() {},
  };
  const proxyModule = { exports: {} };
  runInNewContext(proxy, {
    module: proxyModule, URL, Response, ReadableStream, TextEncoder, TextDecoder,
    Bun: { serve(options) { handler = options.fetch; return { port: 12345, stop() {} }; } },
    async fetch(url, options) {
      const body = JSON.parse(options.body);
      requests.push({ url, headers: options.headers, body });
      if (body.stream) {
        const chunks = [
          { id: 'fixture', choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
      }
      return new Response(JSON.stringify({
        id: 'fixture', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    },
  });
  runInNewContext(launcher, {
    process: proc,
    require(name) {
      if (name === 'os') return { homedir: () => home };
      if (name === './openai-proxy.cjs') return proxyModule.exports;
      if (name === './cli.original.cjs') { loaded = true; return {}; }
      if (['./feature-gates.cjs', './runtime-helpers.cjs', './bun-ant-shim.cjs'].includes(name)) return {};
      return require(name);
    },
  });
  assert.ok(loaded, 'launcher must reach the Claude bundle');
  return {
    env: proc.env,
    async send(fields = {}) {
      assert.ok(handler, 'proxy must be started');
      const body = { model: 'custom-model-alias', messages: [{ role: 'user', content: 'hello' }], max_tokens: 100, ...fields };
      const response = await handler(new Request('http://127.0.0.1:12345/v1/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer proxy-passthrough' },
        body: JSON.stringify(body),
      }));
      assert.equal(response.status, 200);
      if (body.stream) assert.match(await response.text(), /event: message_stop/);
      else assert.equal((await response.json()).content[0].text, 'ok');
      return requests.at(-1);
    },
  };
}

try {
  const custom = { apiKey: 'fixture-key', baseURL: 'https://gateway.invalid', effort: 'high' };
  for (const token of [undefined, '', '   ', '\t', 'fixture-env-token']) {
    const env = { ANTHROPIC_API_KEY: 'stale-key' };
    if (token !== undefined) env.ANTHROPIC_AUTH_TOKEN = token;
    const result = launch(custom, env).env;
    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.ANTHROPIC_AUTH_TOKEN, token?.trim() || custom.apiKey);
    assert.equal(result.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  }
  const official = launch({ apiKey: 'official-key' }, { ANTHROPIC_AUTH_TOKEN: 'stale-token' }).env;
  assert.equal(official.ANTHROPIC_API_KEY, 'official-key');
  assert.equal(official.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(launch({}, { ANTHROPIC_AUTH_TOKEN: 'external-token' }).env.ANTHROPIC_AUTH_TOKEN, 'external-token');
  console.log('[provider.test] direct provider auth, blank tokens, and OAuth preservation ok');

  for (const type of ['grok', 'openai-compat']) {
    const config = { type, apiKey: 'fixture-key', baseURL: 'https://upstream.invalid/v1', model: 'custom-model-alias', smallModel: 'small-alias', timeoutMs: 4321 };
    const session = launch({ ...config, effort: 'low' }, { ANTHROPIC_API_KEY: 'stale-key', ANTHROPIC_AUTH_TOKEN: 'stale-token' });
    assert.equal(session.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(session.env.ANTHROPIC_AUTH_TOKEN, 'proxy-passthrough');
    assert.equal(session.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:12345');
    assert.equal(session.env.ANTHROPIC_MODEL, config.model);
    assert.equal(session.env.ANTHROPIC_SMALL_FAST_MODEL, config.smallModel);
    assert.equal(session.env.API_TIMEOUT_MS, '4321');
    assert.equal(session.env.CLAUDE_CODE_EFFORT_LEVEL, 'low');
    // Unknown model aliases may make Claude omit output_config altogether.
    const request = await session.send();
    assert.equal(request.url, 'https://upstream.invalid/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer fixture-key');
    assert.equal(request.body.reasoning_effort, 'low');

    for (const stream of [false, true]) {
      for (const [input, expected] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'xhigh'], ['auto', undefined]]) {
        const translated = await launch(config).send({ stream, output_config: { effort: input } });
        assert.equal(translated.body.reasoning_effort, expected, `${type}: request effort ${input}, stream=${stream}`);
        assert.equal(translated.body.output_config, undefined);
        const fallback = await launch({ ...config, effort: input }).send({ stream });
        assert.equal(fallback.body.reasoning_effort, expected, `${type}: configured effort ${input}, stream=${stream}`);
      }
    }
    const explicit = launch({ ...config, effort: 'high' }, { CLAUDE_CODE_EFFORT_LEVEL: 'low', API_TIMEOUT_MS: '9876' });
    assert.equal(explicit.env.API_TIMEOUT_MS, '9876');
    assert.equal(explicit.env.CLAUDE_CODE_EFFORT_LEVEL, 'low');
    assert.equal((await explicit.send({ output_config: { effort: 'high' } })).body.reasoning_effort, 'low');
    const automatic = launch({ ...config, effort: 'high' }, { CLAUDE_CODE_EFFORT_LEVEL: 'auto' });
    assert.equal((await automatic.send({ output_config: { effort: 'high' } })).body.reasoning_effort, undefined);
    const empty = launch({ ...config, effort: 'high' }, { CLAUDE_CODE_EFFORT_LEVEL: '' });
    assert.equal((await empty.send()).body.reasoning_effort, undefined);
    assert.equal((await empty.send({ output_config: { effort: 'medium' } })).body.reasoning_effort, 'medium');
    assert.equal((await launch(config).send()).body.reasoning_effort, undefined);
  }
  const grok = launch({ type: 'grok', baseURL: 'https://api.x.ai/v1', effort: 'low' }, { GROK_API_KEY: 'grok-env-key' });
  const grokRequest = await grok.send();
  assert.equal(grokRequest.headers.Authorization, 'Bearer grok-env-key');
  assert.equal(grokRequest.body.reasoning_effort, 'low');
  console.log('[provider.test] proxy auth, effort translation/fallback/precedence, streaming, and defaults ok');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
