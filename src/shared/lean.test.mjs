import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const wrapper = read('./cli.cjs');
const unix = read('../templates/install.sh');
const unixApply = unix.match(/node -e '\n(const fs = require\("fs"\);[\s\S]*?)\n' "\$CLAUDE_SETTINGS" "\$LEAN_IS_MAX"/)[1];
const unixRemove = unix.match(/node -e '\n(const fs=require\("fs"\),p=process.argv\[1\];[\s\S]*?)\n' "\$CLAUDE_SETTINGS"/)[1];
const home = fs.mkdtempSync(join(tmpdir(), 'clawgod-lean-test-'));
const dir = join(home, '.clawgod');
const settings = join(home, '.claude', 'settings.json');
const trafficKey = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
const originalSettings = { theme: 'dark', permissions: { allow: ['Read'], deny: ['Bash(custom)'] } };
const loadSettings = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
const saveSettings = s => fs.writeFileSync(settings, JSON.stringify(s));

function reset() {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  saveSettings(originalSettings);
}

// Execute the entire launcher with only HOME and its final bundle replaced.
// No credentials, user settings, network, or Claude installation are needed.
function launch(args = [], env = {}) {
  const exit = Symbol('exit');
  let loaded = false;
  const proc = { argv: ['node', 'cli.cjs', ...args], env: { ...env }, execPath: '/test/bun',
    stderr: { write() {} }, exit(code) { assert.equal(code, 0); throw exit; } };
  try {
    runInNewContext(wrapper, {
      process: proc,
      require(name) {
        if (name === 'os') return { homedir: () => home };
        if (name === './cli.original.cjs') { loaded = true; return {}; }
        if (['./feature-gates.cjs', './runtime-helpers.cjs', './bun-ant-shim.cjs'].includes(name)) return {};
        return require(name);
      },
    });
  } catch (error) {
    if (error !== exit) throw error;
  }
  assert.equal(loaded, args.length === 0);
  return proc.env;
}

function checkMode(mode) {
  const s = loadSettings();
  assert.equal(s.disableRemoteControl, mode === 'max' ? true : undefined, mode);
  assert.equal(s.disableBundledSkills, mode === 'max' ? true : undefined, mode);
  assert.equal(s.disableWorkflows, mode === 'off' ? undefined : true, mode);
  assert.equal(s.permissions.deny.includes('EnterPlanMode'), mode === 'max', mode);
  assert.equal(s.permissions.deny.includes('CronCreate'), mode !== 'off', mode);
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.permissions.allow, ['Read']);
  assert.ok(s.permissions.deny.includes('Bash(custom)'));
}

try {
  fs.mkdirSync(join(home, '.claude'));
  for (const [platform, apply, remove, maxArg] of [
    ['Unix', unixApply, unixRemove, 'true'],
    // PowerShell interpolates its Boolean as "True", not "true".
    ['Windows', read('../windows/lean-apply.cjs'), read('../windows/lean-remove.cjs'), 'True'],
  ]) {
    const run = (code, arg) => runInNewContext(code, { require, process: { argv: ['node', settings, arg] } });
    reset();
    run(apply, 'false');
    checkMode('on');
    // Upgrade an existing default installation from before #186.
    saveSettings({ ...loadSettings(), disableRemoteControl: true });
    run(apply, 'false');
    checkMode('on');
    run(apply, maxArg);
    checkMode('max');
    run(apply, maxArg);
    checkMode('max');
    run(apply, 'false');
    checkMode('on');
    run(apply, maxArg);
    run(remove);
    checkMode('off');
    console.log(`[lean.test] ${platform} install, legacy migration, max/on/off transitions ok`);
  }

  for (const baseURL of ['https://api.anthropic.com', 'https://example.invalid']) {
    reset();
    fs.writeFileSync(join(dir, 'provider.json'), JSON.stringify({ baseURL }));
    // Default startup must not disable the feature-flag service.
    assert.equal(launch()[trafficKey], undefined);
    saveSettings({ ...loadSettings(), disableRemoteControl: true });
    for (const mode of ['on', 'max', 'on', 'max', 'off', 'on']) {
      launch([`--lean-${mode}`]);
      checkMode(mode);
      assert.equal(fs.existsSync(join(dir, '.lean-max')), mode === 'max');
      assert.equal(fs.existsSync(join(dir, '.lean-disabled')), mode === 'off');
      assert.equal(launch()[trafficKey], mode === 'max' ? '1' : undefined);
      checkMode(mode); // A proxy launch must not silently undo max settings.
      for (const explicit of ['1', '0', '']) {
        assert.equal(launch([], { [trafficKey]: explicit })[trafficKey], explicit);
      }
      assert.equal(launch([], { DISABLE_TELEMETRY: '1' }).DISABLE_TELEMETRY, '1');
    }
    // Existing per-setting opt-outs keep the documented absent-only behavior.
    saveSettings({ ...loadSettings(), disableRemoteControl: false });
    launch(['--lean-max']);
    assert.equal(loadSettings().disableRemoteControl, false);
  }
  console.log('[lean.test] launcher modes, provider parity, and explicit environment settings ok');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
