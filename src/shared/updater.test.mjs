import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const wrapper = fs.readFileSync(new URL('./cli.cjs', import.meta.url), 'utf8');
const home = fs.mkdtempSync(join(tmpdir(), 'clawgod-updater-test-'));
const dir = join(home, '.clawgod');
fs.mkdirSync(dir);

try {
  for (const mode of ['on', 'off', 'max']) {
    for (const marker of ['.lean-disabled', '.lean-max']) fs.rmSync(join(dir, marker), { force: true });
    if (mode !== 'on') fs.writeFileSync(join(dir, mode === 'off' ? '.lean-disabled' : '.lean-max'), '');
    for (const inherited of [undefined, '', '0', 'false', '1']) {
      const env = inherited === undefined ? {} : { DISABLE_AUTOUPDATER: inherited };
      let loaded = false;
      runInNewContext(wrapper, {
        process: { argv: ['bun', 'cli.cjs'], env, execPath: '/test/bun', stderr: { write() {} } },
        require(name) {
          if (name === 'os') return { homedir: () => home };
          if (name === './cli.original.cjs') {
            // Check at bundle load time, before upstream captures environment.
            assert.equal(env.DISABLE_AUTOUPDATER, '1', `${mode}, inherited=${inherited}`);
            loaded = true;
            return {};
          }
          if (['./feature-gates.cjs', './runtime-helpers.cjs', './bun-ant-shim.cjs'].includes(name)) return {};
          return require(name);
        },
      });
      assert.ok(loaded);
    }
  }
  console.log('[updater.test] native auto-updates disabled before bundle load in every Lean mode');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
