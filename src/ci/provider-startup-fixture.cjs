'use strict';
// CI-only fixture: exercise the actual installed Claude graph with a configured
// provider across fresh installs, --no-upgrade and version queries. No API calls
// are needed, and port 9 deliberately cannot serve a completion request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
if (process.env.CI !== 'true') throw new Error('This fixture may only modify a disposable CI runner profile');
const dir = join(homedir(), '.clawgod');
const path = join(dir, 'provider.json');
const provider = {
  ...(process.env.CLAWGOD_VERSION === '2.1.272' ? { type: 'openai-compat' } : { protocol: 'openai-chat' }),
  apiKey: 'ci-fixture-not-a-real-key', baseURL: 'http://127.0.0.1:9/v1', model: 'ci-fixture',
};
if (process.argv[2] === 'seed') {
  fs.mkdirSync(dir, { recursive: true });
  assert.ok(!fs.existsSync(path), 'Never overwrite an existing provider with the CI fixture');
  fs.writeFileSync(path, JSON.stringify(provider, null, 2) + '\n');
} else if (process.argv[2] === 'verify') {
  assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), provider, 'Installer must preserve provider settings');
  const logs = [join(dir, 'startup-check.log'), ...process.argv.slice(3)];
  for (const log of logs) {
    const output = fs.readFileSync(log, 'utf8');
    assert.doesNotMatch(output, /proxy on port/i, 'Version probes must not start a provider listener');
  }
  assert.match(fs.readFileSync(logs[0], 'utf8'), /^\d+\.\d+\.\d+[^\r\n]*\(Claude Code\)\s*$/m);
  console.log('Installed Claude version check passed with configured provider; settings preserved');
} else throw new Error('Usage: provider-startup-fixture.cjs seed|verify [installer logs...]');
