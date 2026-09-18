import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { terminalReplyDelay } from './runtime-helpers.cjs';

const pending = { queue: [{ kind: 'sentinel', written: true }] };
const reader = (incomplete, mode = 'NORMAL') => ({ parse: { mode, incomplete }, lastInputAt: 100 });
for (const prefix of ['\x1b', '\x1b[', '\x1b[?', '\x1b[?61;4;6;']) {
  assert.equal(terminalReplyDelay(pending, reader(prefix), 150), 1950);
  assert.equal(terminalReplyDelay(pending, reader(prefix), 2100), 0, 'timeout remains bounded');
  for (const querier of [null, {}, { queue: [] }, { queue: [{ kind: 'query' }] },
    { queue: [{ kind: 'sentinel', written: false }] }]) {
    assert.equal(terminalReplyDelay(querier, reader(prefix), 150), 0, 'no sent DA1 probe: normal timing');
  }
  assert.equal(terminalReplyDelay({ queue: [{ kind: 'sentinel' }] }, reader(prefix), 150), 1950, 'legacy query queue');
  assert.equal(terminalReplyDelay({ queue: [{ kind: 'barrier' }] }, reader(prefix), 150), 1950, 'resync DA1 probe');
}
for (const input of ['', 'hello', '22;23;24;28;32;42;52c', '\x03', '\x1b[A', '\x1b[?61;4c', '\x1b[x']) {
  assert.equal(terminalReplyDelay(pending, reader(input), 150), 0, `do not delay ${JSON.stringify(input)}`);
}
assert.equal(terminalReplyDelay(pending, reader('\x1b[', 'IN_PASTE'), 150), 0);
assert.equal(terminalReplyDelay(pending, reader('\x1b['), NaN), 0);

// Exercise the actual emitted callback, including older minified identifiers,
// graph/legacy patching, idempotence, expiry, and a wrapper without the helper.
const dir = mkdtempSync(join(tmpdir(), 'clawgod-terminal-reply-test-'));
try {
  copyFileSync(new URL('./patch.mjs', import.meta.url), join(dir, 'patch.mjs'));
  for (const graph of [false, true]) {
    if (graph) mkdirSync(join(dir, 'bunfs'));
    for (const names of [['Hf', 'za', 't', 'Ry'], ['zf', 'Lr', 'n', 'E0']]) {
      const [hasInput, wait, now, flush] = names;
      const source = `globalThis.App=class{flushIncomplete=()=>{if(this.incompleteEscapeTimer=null,!${hasInput}(this.keyReader))return;if(this.props.stdin.readableLength>0){this.incompleteEscapeTimer=setTimeout(this.flushIncomplete,${wait});return}let ${now}=performance.now();this.applyKeysRead(${flush}(this.keyReader,${now}),${now})}};`;
      const target = join(dir, graph ? 'bunfs/renderer.js' : 'cli.original.cjs');
      if (graph) writeFileSync(join(dir, 'cli.original.cjs'), '// graph entry\n');
      writeFileSync(target, source);
      execFileSync(process.execPath, [join(dir, 'patch.mjs')]);
      const patched = readFileSync(target, 'utf8');
      assert.ok(patched.includes('globalThis.__clawgodHelpers?.terminalReplyDelay'));
      execFileSync(process.execPath, [join(dir, 'patch.mjs')]);
      assert.equal(readFileSync(target, 'utf8'), patched);

      let clock = 150, scheduled, flushed = 0;
      const context = {
        __clawgodHelpers: { terminalReplyDelay },
        performance: { now: () => clock },
        setTimeout: (fn, ms) => { scheduled = { fn, ms }; return 42; },
        [hasInput]: (r) => !!r.parse.incomplete,
        [wait]: 50,
        [flush]: (r) => { flushed++; return r.parse.incomplete; },
      };
      runInNewContext(patched, context);
      const app = new context.App();
      Object.assign(app, { keyReader: reader('\x1b['), querier: pending,
        props: { stdin: { readableLength: 0 } }, applyKeysRead: (value) => { app.delivered = value; } });
      app.flushIncomplete();
      assert.equal(flushed, 0);
      assert.equal(scheduled.ms, 1950);
      assert.equal(app.incompleteEscapeTimer, 42);
      clock = 2100;
      scheduled.fn();
      assert.equal(app.delivered, '\x1b[', 'Alt+[ is preserved when no reply completes it');
      assert.equal(flushed, 1);
      clock = 150;
      app.querier = { queue: [] };
      app.keyReader = reader('\x1b');
      app.flushIncomplete();
      assert.equal(app.delivered, '\x1b', 'Escape remains immediate after its normal timer without probes');
      app.querier = pending;
      delete context.__clawgodHelpers;
      app.flushIncomplete();
      assert.equal(flushed, 3, 'older wrapper keeps its original callback');
      app.props.stdin.readableLength = 1;
      app.flushIncomplete();
      assert.equal(scheduled.ms, 50, 'buffered stdin retains the original retry path');
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('[terminal-reply.test] pending DA1 fragments, keyboard fallback, timeout, and patch composition ok');
