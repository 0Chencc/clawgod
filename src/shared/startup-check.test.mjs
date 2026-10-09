import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const sourceDir = dirname(fileURLToPath(import.meta.url));
const checker = join(sourceDir, 'startup-check.cjs');
const wrapper = fs.readFileSync(join(sourceDir, 'cli.cjs'), 'utf8');
const root = fs.mkdtempSync(join(tmpdir(), 'clawgod startup test-'));
const dir = join(root, 'profile space \u6d4b\u8bd5', '.clawgod');
fs.mkdirSync(dir, { recursive: true });
const cli = join(dir, 'cli.cjs');
const log = join(dir, 'startup-check.log');
const env = { ...process.env, CLAWGOD_STARTUP_TIMEOUT_MS: '10000' };
function check(code, options = {}) {
  fs.writeFileSync(cli, code);
  return spawnSync(process.execPath, [checker, process.execPath, cli], { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024, env, ...options });
}
const version = '2.1.285 (Claude Code)';
try {
  let r = check(`if(process.argv[2]!=='--version')process.exit(9); console.log(${JSON.stringify(version)});`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2\.1\.285 \(Claude Code\)/);
  assert.equal(fs.readFileSync(log, 'utf8'), version + '\n');
  // Closed stdin prevents an installer probe from entering an interactive prompt.
  r = check(`if(require('fs').readFileSync(0,'utf8')!=='')process.exit(8); console.log(${JSON.stringify(version)});`);
  assert.equal(r.status, 0, r.stderr);
  r = check('console.error("fixture startup failure"); process.exit(7);');
  assert.equal(r.status, 7);
  assert.match(r.stdout + r.stderr, /fixture startup failure/);
  assert.match(fs.readFileSync(log, 'utf8'), /fixture startup failure/);
  r = check('console.error("Expected CommonJS module to have a function wrapper"); process.exit(1);');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Expected CommonJS module to have a function wrapper/);
  for (const output of ['', 'console.log("unrelated 2.1.285 output");']) {
    r = check(output);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /did not print a Claude Code version/);
  }
  r = check(`console.error(${JSON.stringify(version)});`);
  assert.equal(r.status, 1, 'A version quoted only in stderr is not successful --version output');
  r = check(`process.stdout.write('2.1.'); setTimeout(()=>{console.error('interleaved warning');process.stdout.write('285 (Claude Code)');},20);`);
  assert.equal(r.status, 0, 'stderr must not split stdout version detection');
  r = check(`console.log(${JSON.stringify(version)}); process.stderr.write('x'.repeat(1200000));`);
  assert.equal(r.status, 0, 'bounded diagnostic logs must not discard a valid earlier version');
  r = spawnSync(process.execPath, [checker, join(root, 'missing-bun'), cli], { encoding: 'utf8', timeout: 5000, env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not start Bun/);
  for (const limit of ['invalid', '0', '-1', '2147483648']) {
    r = check('throw Error("must not run")', { env: { ...env, CLAWGOD_STARTUP_TIMEOUT_MS: limit } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /positive integer/);
  }
  // This was the failure shape in #203: --version has printed but a server or
  // interval keeps Bun alive. A silent/blocking startup must also be bounded.
  for (const code of [`console.log(${JSON.stringify(version)}); setInterval(()=>{},1000);`, 'while(true){}']) {
    const started = Date.now();
    r = check(code, { env: { ...env, CLAWGOD_STARTUP_TIMEOUT_MS: '1200' } });
    assert.equal(r.status, 124, r.stderr);
    assert.ok(Date.now() - started < 8000, 'watchdog must bound process and pipe lifetime');
    assert.match(r.stderr, /timed out after 1200 ms/);
    assert.match(r.stderr, /Startup log:/);
    assert.match(fs.readFileSync(log, 'utf8'), /launcher installation was aborted/);
  }
  // A child inheriting the probe's pipes must not survive the timeout either.
  const childPidFile = join(dir, 'child.pid');
  try {
    r = check(`const cp=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); require('fs').writeFileSync(${JSON.stringify(childPidFile)},String(cp.pid)); setInterval(()=>{},1000);`, { env: { ...env, CLAWGOD_STARTUP_TIMEOUT_MS: '1200' } });
    assert.equal(r.status, 124, r.stderr);
    const pid = Number(fs.readFileSync(childPidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 30 && alive; attempt++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 100)); }
      catch (error) { assert.equal(error.code, 'ESRCH'); alive = false; }
    }
    assert.equal(alive, false, 'timeout must terminate probe descendants');
  } finally {
    if (fs.existsSync(childPidFile)) {
      try { process.kill(Number(fs.readFileSync(childPidFile, 'utf8')), 'SIGKILL'); } catch {}
    }
  }
  r = check(`process.stdout.write('x'.repeat(1200000),()=>{ console.error('output-tail'); process.exitCode=3; });`);
  assert.equal(r.status, 3);
  const boundedLog = fs.readFileSync(log, 'utf8');
  assert.ok(Buffer.byteLength(boundedLog) < 1100000);
  assert.match(boundedLog, /Earlier startup output truncated/);
  assert.match(boundedLog, /output-tail/);
  fs.rmSync(log);
  fs.mkdirSync(log);
  try {
    r = check(`console.log(${JSON.stringify(version)});`);
    assert.equal(r.status, 1, 'Log write failure must be reported');
    assert.match(r.stderr, /Cannot write startup log/);
    assert.doesNotMatch(r.stderr, /\[clawgod\] Startup log:/, 'Do not advertise a log that was not written');
  } finally { fs.rmSync(log, { recursive: true }); }
  console.log('[startup-check.test] version output, exit codes, closed stdin, paths, timeouts and bounded logs passed');

  // Check the real launcher before loading Claude: no provider reads, migration,
  // API listener or release-check fetch may run for standalone version queries.
  const profile = dirname(dir);
  const config = join(dir, 'provider.json');
  fs.writeFileSync(join(dir, '.claude.json'), '{"migration":"must stay"}');
  fs.writeFileSync(join(dir, '.clawgod-version'), '2.0.0');
  for (const flag of ['--version', '-v']) {
    for (const provider of [undefined, { protocol: 'openai-chat', apiKey: 'fixture', baseURL: 'https://example.invalid/v1' }, { type: 'openai-compat', apiKey: 'fixture', baseURL: 'https://example.invalid/v1' }, { type: 'grok', apiKey: 'fixture' }, { protocol: 'invalid' }]) {
      if (provider) fs.writeFileSync(config, JSON.stringify(provider));
      else fs.rmSync(config, { force: true });
      const before = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null;
      let loaded = false, network = false;
      const modules = [];
      runInNewContext(wrapper, {
        process: { argv: ['bun', cli, flag], env: {}, execPath: '/test/bun', stderr: { write() {} } },
        fetch() { network = true; throw new Error('version must not fetch'); },
        AbortSignal,
        require(name) {
          if (name === 'os') return { homedir: () => profile };
          if (name === './openai-proxy.cjs') throw new Error('version must not start a provider');
          if (['./feature-gates.cjs', './runtime-helpers.cjs', './bun-ant-shim.cjs'].includes(name)) { modules.push(name); return {}; }
          if (name === './cli.original.cjs') { loaded = true; return {}; }
          return require(name);
        },
      });
      assert.equal(loaded, true);
      assert.equal(network, false);
      assert.deepEqual(modules, ['./feature-gates.cjs', './runtime-helpers.cjs', './bun-ant-shim.cjs']);
      assert.equal(fs.existsSync(join(dir, '.claude.json')), true);
      assert.equal(fs.existsSync(join(profile, '.claude.json')), false);
      assert.equal(fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null, before);
    }
  }
  // A prompt/update argument containing --version is not a version-only query.
  fs.writeFileSync(config, JSON.stringify({ protocol: 'invalid' }));
  for (const args of [['update', '--version', '2.1.285'], ['-p', '--version']]) {
    assert.throws(() => runInNewContext(wrapper, {
      process: { argv: ['bun', cli, ...args], env: {} },
      require(name) { return name === 'os' ? { homedir: () => profile } : require(name); },
    }), /Unsupported provider protocol/);
  }
  console.log('[startup-check.test] standalone version skips provider/update side effects and still loads runtime helpers/bundle');

  // Real Bun process regression, enabled in Unix/Windows smoke CI and locally
  // when Bun is available. No user home or credentials are read or modified.
  const bun = process.env.CLAWGOD_TEST_BUN || 'bun';
  const available = spawnSync(bun, ['--version'], { timeout: 5000, encoding: 'utf8' });
  if (available.status === 0) {
    fs.writeFileSync(cli, wrapper);
    fs.copyFileSync(join(sourceDir, 'openai-proxy.cjs'), join(dir, 'openai-proxy.cjs'));
    for (const name of ['feature-gates.cjs', 'runtime-helpers.cjs', 'bun-ant-shim.cjs']) fs.writeFileSync(join(dir, name), '');
    fs.writeFileSync(join(dir, 'cli.original.cjs'), `console.log(${JSON.stringify(version)});`);
    fs.writeFileSync(config, JSON.stringify({ protocol: 'openai-chat', apiKey: 'fixture', baseURL: 'https://example.invalid/v1' }));
    const entry = join(dir, 'entry.cjs');
    fs.writeFileSync(entry, `require('os').homedir=()=>${JSON.stringify(profile)}; global.fetch=()=>{throw Error('unexpected version fetch')}; require('./cli.cjs');`);
    r = spawnSync(process.execPath, [checker, bun, entry], { encoding: 'utf8', env: { ...env, CLAWGOD_STARTUP_TIMEOUT_MS: '3000' }, timeout: 8000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), version);
    assert.doesNotMatch(r.stderr, /proxy on port/);
    console.log('[startup-check.test] real Bun exits after --version with an OpenAI provider configured');
  } else {
    assert.ok(!process.env.CLAWGOD_TEST_BUN, 'Explicit test Bun must be executable');
    console.log('[startup-check.test] Bun unavailable: real runtime case skipped');
  }

  // Run the actual POSIX installer check section without installing anything.
  if (process.platform !== 'win32') {
    const template = fs.readFileSync(join(sourceDir, '../templates/install.sh'), 'utf8');
    const section = template.slice(template.indexOf('dim "Verifying Bun'), template.indexOf('# ─── Replace claude command'));
    assert.ok(section.startsWith('dim "Verifying Bun'));
    fs.copyFileSync(checker, join(dir, 'startup-check.cjs'));
    const script = `set -e\nCLAWGOD_DIR="$1"\nBUN_BIN="$2"\nwarn(){ printf '%s\\n' "$*"; }\ninfo(){ printf '%s\\n' "$*"; }\ndim(){ :; }\nrollback_install(){ :; }\n${section}\nprintf 'launcher-step-reached\\n'\n`;
    for (const [code, expected] of [
      [`console.log(${JSON.stringify(version)});`, 0],
      ['console.error("fixture failed"); process.exit(7);', 7],
      ['setInterval(()=>{},1000);', 124],
      ['console.log("Expected CommonJS module to have a function wrapper"); process.exit(1);', 1],
    ]) {
      fs.writeFileSync(cli, code);
      r = spawnSync('bash', ['-c', script, 'test', dir, process.execPath], { encoding: 'utf8', timeout: 8000, env: { ...env, CLAWGOD_STARTUP_TIMEOUT_MS: '1200' } });
      assert.equal(r.status, expected, r.stdout + r.stderr);
      assert.equal(r.stdout.includes('launcher-step-reached'), expected === 0);
      assert.equal(r.stdout.includes('Bun loads cli.original.cjs'), expected === 0);
    }
    console.log('[startup-check.test] Unix installer preserves failure/timeout status before launcher replacement');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
