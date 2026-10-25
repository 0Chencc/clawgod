import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { AST_PATCH_IDS, scanAstPatches, applyAstEdits, parsePatchSource } from './ast-patches.mjs';

const source = `
// function userType(){return"external"} name:"ultraplan"
const decoy='function userType(){return"external"}';
function userType () { return 'external'; }
function standalone () { return typeof Bun < 'u' && Bun['isStandaloneExecutable'] === true; }
function voice () { return !flag('tengu_amber_quartz_disabled', false); }
const config={pixelValidation:123, 'enabled':false};
const command={isEnabled(){'use strict';return this.allowed}, extra:{name:'nested'}, 'name':'ultraplan', allowed:false};
const neighbor={name:'other',isEnabled:()=>false};
class GrowthBook {
  environmentOverridesParsed=false;environmentOverrides={};
  deps={readEnvironmentOverrides(){return '{"flag":true}'}};
  getEnvironmentOverrides(){
    if(this.environmentOverridesParsed)return this.environmentOverrides;
    return this.environmentOverridesParsed=true,this.environmentOverrides;
    const renamed=this.deps.readEnvironmentOverrides();
    this.environmentOverrides=JSON.parse(renamed);
    return this.environmentOverrides;
  }
}
const unrelated={method(){return this.environmentOverridesParsed=true,this.environmentOverrides;}};
`;
const dateSource = 'function dateText (input) {let info=probe(),mark=apostrophe(info?.known??false,info?.labKw??false),formatted=info?.cnTZ?input.replaceAll("-","/"):input;return`Today${mark}s date is ${formatted}.`}';
const scanned = scanAstPatches(source + dateSource);
for (const id of AST_PATCH_IDS) assert.equal(scanned[id].matches.length,
  ['remote-settings-off', 'wiggly-dove', 'tool-result-pairing-recovery'].includes(id) ? 0 : 1, id);
const edits = Object.values(scanned).flatMap(result => result.matches);
const patched = applyAstEdits(source + dateSource, edits);
parsePatchSource(patched);
assert.ok(patched.includes("const decoy='function userType(){return\"external\"}';"));
assert.ok(patched.includes('// function userType(){return"external"} name:"ultraplan"'));
assert.ok(patched.includes("const neighbor={name:'other',isEnabled:()=>false};"));
assert.ok(patched.includes('return this.environmentOverridesParsed=true,this.environmentOverrides;}};'));

for (const toggle of [undefined, true, false]) {
  let calls = 0;
  const context = {
    Bun: { isStandaloneExecutable: false },
    flag: () => { calls++; return true; },
    probe: () => ({ cnTZ: true, known: true }), apostrophe: () => '\u2019',
    ...(toggle === undefined ? {} : { __clawgodPatches: Object.fromEntries(AST_PATCH_IDS.map(id => [id, toggle])) }),
  };
  const result = runInNewContext(`${patched};const gb=new GrowthBook();
    [userType(),standalone(),voice(),config.enabled,command.isEnabled(),neighbor.isEnabled(),
     gb.getEnvironmentOverrides().flag,gb.getEnvironmentOverrides().flag,gb.environmentOverridesParsed,dateText("2026-10-12")]`, context);
  assert.deepEqual(Array.from(result), ['ant', true, toggle !== false, toggle !== false,
    toggle !== false, false, true, true, true, toggle === false ? "Today\u2019s date is 2026/10/12." : "Today's date is 2026-10-12."]);
  assert.equal(calls, toggle === false ? 1 : 0);
}
assert.equal(applyAstEdits(patched, Object.values(scanAstPatches(patched)).flatMap(r => r.matches)), patched,
  'repeated patching without a snapshot must not nest gates');

const privacyGate = `function allowed () {'use strict';if (!firstParty()) return false;
  if (!lookup(rollout, false)) return false;return routeAllowed();}`;
const shadowedGate = `function neighbor(){const rollout='other';if(!firstParty())return false;
  if(!lookup(rollout,false))return false;return routeAllowed()}`;
for (const declaration of ['var', 'let', 'const']) {
  const source = `(function(){${declaration} rollout = 'tengu_wiggly_dove';${privacyGate}${shadowedGate}})();`;
  const scanned = scanAstPatches(source)['wiggly-dove'];
  assert.equal(scanned.matches.length, 1, `${declaration}: match the enclosing flag binding`);
  const patched = applyAstEdits(source, scanned.matches);
  parsePatchSource(patched);
  assert.ok(patched.includes(shadowedGate), 'a shadowed flag remains untouched');
  assert.ok(patched.includes("'use strict';;if(globalThis.__clawgodPatches"), 'keep the directive first');
  assert.equal(scanAstPatches(patched)['wiggly-dove'].patched, true);
  assert.equal(scanAstPatches(patched)['wiggly-dove'].matches.length, 0);
}
for (const source of [
  `const rollout='tengu_wiggly_dove';function unknown(){return lookup(rollout,false)}`,
  `function unknown(){return lookup('tengu_wiggly_dove',false)}`,
  `const rollout='tengu_wiggly_dove';${privacyGate}function unknown(){return lookup('tengu_wiggly_dove',false)}`,
  `const rollout='tengu_wiggly_dove';${privacyGate}${privacyGate.replace('allowed', 'ambiguous')}`,
]) {
  const result = scanAstPatches(source)['wiggly-dove'];
  assert.equal(result.present, true, 'unhandled or ambiguous flag uses are stale');
  assert.equal(result.matches.length, 0, 'do not claim partial privacy protection');
}
assert.equal(scanAstPatches(`// const rollout='tengu_wiggly_dove';\nconst text="function f(){return 'tengu_wiggly_dove'}";`)['wiggly-dove'].present, false,
  'comments and source text are not flag bindings');

// The remote-settings gate has the same cache/`{eligible}` shape as ordinary
// feature checks. It is only a patch site when its helper carries remote
// settings context; a look-alike must remain untouched.
const remoteSettingsSource = `
function remoteEligibilityDetails(){remoteLog('Remote settings: checking eligibility');return{eligible:remoteUpstream(),ineligibleReason:'no_auth'}}
function remoteSettingsEligibility(){let cached=readRemoteCache();if(cached!==void 0)return cached;let{eligible,ineligibleReason}=remoteEligibilityDetails();if(eligible)recordRemoteSettings();return saveRemoteEligibility(eligible,ineligibleReason)}
function ordinaryEligibilityDetails(){return{eligible:ordinaryUpstream()}}
function ordinaryEligibility(){let cached=readOrdinaryCache();if(cached!==void 0)return cached;let{eligible}=ordinaryEligibilityDetails();return eligible}
`;
const remoteScan = scanAstPatches(remoteSettingsSource);
assert.equal(remoteScan['remote-settings-off'].matches.length, 1);
assert.equal(remoteScan['remote-settings-off'].present, false);
const remotePatched = applyAstEdits(remoteSettingsSource, remoteScan['remote-settings-off'].matches);
assert.match(remotePatched, /function ordinaryEligibility\(\)\{let cached=readOrdinaryCache\(\)/);
for (const enabled of [true, false]) {
  let reads = 0, details = 0, records = 0;
  const result = runInNewContext(`${remotePatched};[remoteSettingsEligibility(),ordinaryEligibility()]`, {
    __clawgodPatches: { 'remote-settings-off': enabled },
    readRemoteCache: () => { reads++; return undefined; },
    remoteUpstream: () => { details++; return true; }, remoteLog: () => {},
    recordRemoteSettings: () => { records++; }, saveRemoteEligibility: value => value,
    readOrdinaryCache: () => undefined, ordinaryUpstream: () => false,
  });
  assert.deepEqual(Array.from(result), [enabled ? false : true, false]);
  assert.equal(reads, enabled ? 0 : 1);
  assert.equal(details, enabled ? 0 : 1);
  assert.equal(records, enabled ? 0 : 1);
}
assert.equal(applyAstEdits(remotePatched, scanAstPatches(remotePatched)['remote-settings-off'].matches), remotePatched,
  'remote-settings patch must be idempotent');

// Remote context without the cache/eligibility structure is matcher drift,
// not an older Claude version where remote settings do not exist.
const remoteDrift = "function remoteEligibilityDetails(){log('Remote settings: checking eligibility');return{eligible:true}}function changedGate(){let{eligible}=remoteEligibilityDetails();return eligible}";
const driftScan = scanAstPatches(remoteDrift)['remote-settings-off'];
assert.equal(driftScan.matches.length, 0);
assert.equal(driftScan.present, true);
assert.equal(scanAstPatches("function remoteLogOnly(){log('Remote settings: background refresh')}")['remote-settings-off'].present, false,
  'unrelated remote-settings chunks must not make a reapply look stale');
assert.throws(() => applyAstEdits('abcd', [
  { start: 0, end: 3, replacement: '' }, { start: 1, end: 4, replacement: '' },
]), /Overlapping/);

// Object boundaries, exact keys, unknown writes and accessors must not be guessed.
for (const candidate of [
  "const command={name:'ultraplan',isEnabled:futureGate};",
  "const command={name:'ultraplan',get isEnabled(){return ()=>false}};",
  "const command={name:'ultraplan',isEnabled:()=>false,...rest};",
  "const command={name:'ultraplan',isEnabled:()=>false,isEnabled:other};",
  "const command={name:'ultraplan',isEnabled:()=>false,[unknown]:true};",
  "const command={name:'ultraplan',isEnabled:async()=>false};",
]) {
  const result = scanAstPatches(candidate);
  assert.equal(result.ultraplan.present, true);
  assert.equal(result.ultraplan.matches.length, 0, candidate);
}
for (const candidate of [
  "const command={subname:'ultraplan',isEnabled:()=>false};",
  "const command={name:'other',metadata:{name:'ultraplan'},isEnabled:()=>false};",
  "const config={pixelValidationAt:1,enabled:false};",
  "const config={pixelValidation:1,get enabled(){return false}};",
  "const config={pixelValidation:1,enabled:false,...other};",
  "function other(){return fakeBun.isStandaloneExecutable===true}",
  "function other(){return flag('tengu_amber_quartz_disabled',false)}",
  "function other(){return !flag('tengu_amber_quartz_disabledExtra',false)}",
]) {
  assert.equal(Object.values(scanAstPatches(candidate)).flatMap(r => r.matches).length, 0, candidate);
}

// Formerly fragile shapes: metadata order/size, quotes, computed literal keys,
// block arrows and ordinary functions, with original `this` and side effects.
for (const fn of ['()=>upstream()', '()=>{return upstream()}', 'function(){return upstream()}']) {
  const input = `const c={'isEnabled':${fn},metadata:'${'x'.repeat(600)}',['name']:'ultraplan'};`;
  const result = scanAstPatches(input);
  assert.equal(result.ultraplan.matches.length, 1);
  const output = applyAstEdits(input, result.ultraplan.matches);
  for (const toggle of [true, false]) {
    let calls = 0;
    assert.equal(runInNewContext(`${output};c.isEnabled()`, {
      __clawgodPatches: { ultraplan: toggle }, upstream: () => { calls++; return false; },
    }), toggle);
    assert.equal(calls, toggle ? 0 : 1);
  }
}

// A directive without a semicolon must remain a directive after injection.
const strict = "const c={name:'ultraplan',isEnabled:function(){'use strict'\nreturn this===undefined}};";
const strictPatched = applyAstEdits(strict, scanAstPatches(strict).ultraplan.matches);
assert.equal(runInNewContext(`${strictPatched};const f=c.isEnabled;f()`, { __clawgodPatches: { ultraplan: false } }), true);

const root = mkdtempSync(join(tmpdir(), 'clawgod-ast-test-'));
try {
  for (const graph of [false, true]) {
    const dir = join(root, graph ? 'graph' : 'legacy');
    mkdirSync(dir);
    for (const name of ['patch.mjs', 'ast-patches.mjs', 'acorn.mjs']) {
      copyFileSync(new URL(`./${name}`, import.meta.url), join(dir, name));
    }
    const entry = join(dir, 'cli.original.cjs');
    if (graph) { mkdirSync(join(dir, 'bunfs')); writeFileSync(entry, '// entry'); }
    const target = graph ? join(dir, 'bunfs/commands.js') : entry;
    const run = (...args) => spawnSync(process.execPath, [join(dir, 'patch.mjs'), ...args], { encoding: 'utf8' });
    writeFileSync(target, source + dateSource);
    assert.equal(run('--dry-run').status, 0);
    assert.equal(readFileSync(target, 'utf8'), source + dateSource, 'dry-run must not write');
    assert.equal(run('--verify').status, 0);
    assert.equal(readFileSync(target, 'utf8'), source + dateSource, 'verify must not write');
    assert.equal(run('--capture-clean-source').status, 0);
    const first = run();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const firstPatched = readFileSync(target, 'utf8');
    assert.equal(run().stdout.match(/Result:.*/)[0], first.stdout.match(/Result:.*/)[0]);
    assert.equal(readFileSync(target, 'utf8'), firstPatched);
    assert.equal(run('--revert').status, 0);
    assert.equal(readFileSync(target, 'utf8'), source + dateSource);

    rmSync(join(dir, 'source-backup.json'));
    writeFileSync(target, firstPatched);
    assert.equal(run('--verify').status, 0, 'verify recognizes the baked-in AST gate');
    assert.equal(run().status, 0, 'reapplying without a snapshot is safe');
    assert.equal(readFileSync(target, 'utf8'), firstPatched);

    // Re-capture malformed source: even --tolerate-stale cannot waive syntax errors.
    const invalid = "const command={name:'ultraplan',isEnabled:()=>false;";
    writeFileSync(target, invalid);
    assert.equal(run('--capture-clean-source').status, 0);
    for (const args of [[], ['--tolerate-stale'], ['--dry-run'], ['--verify']]) {
      const failure = run(...args);
      assert.equal(failure.status, 1);
      assert.match(failure.stderr, /AST scan failed/);
      assert.equal(readFileSync(target, 'utf8'), invalid);
    }
    const unsupported = "const command={name:'ultraplan',isEnabled:futureGate};function userType(){return 'external'}";
    writeFileSync(target, unsupported);
    assert.equal(run('--capture-clean-source').status, 0);
    assert.equal(run().status, 1);
    assert.equal(readFileSync(target, 'utf8'), unsupported, 'stale AST shape aborts every source write');
    const tolerant = run('--tolerate-stale');
    assert.equal(tolerant.status, 0, tolerant.stderr);
    assert.match(tolerant.stdout, /AST matcher stale.*tolerated/);
    assert.match(readFileSync(target, 'utf8'), /return "ant"/);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
// tool-result-pairing-recovery AST patch tests:
// Verifies renamed history array bindings, real result recovery, missing fallback,
// idempotence, and stale sentinel detection when structures drift.
{
  const renamedSource = `
    function ensureToolResultPairing(conversationHistory, options) {
      let count = conversationHistory.length;
      let missingIds = ["call_cached", "call_missing"];
      let defaultErr = "[Tool result missing due to internal error]";
      let results = missingIds.map((item) => ({
        type: "tool_result",
        tool_use_id: item,
        content: defaultErr,
        is_error: !0
      }));
      return results;
    }
  `;
  const scannedPairing = scanAstPatches(renamedSource)['tool-result-pairing-recovery'];
  assert.equal(scannedPairing.matches.length, 1, 'matches map with renamed history parameter');
  assert.equal(scannedPairing.present, false);
  assert.equal(scannedPairing.patched, false);

  const patchedPairing = applyAstEdits(renamedSource, scannedPairing.matches);
  parsePatchSource(patchedPairing);
  assert.ok(patchedPairing.includes('for(let _m of conversationHistory)'), 'binds to the renamed parameter name');

  // Verify execution: real result recovery vs missing fallback
  const mockHistory = [
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'call_cached', content: 'PASS: suite verified', is_error: false }
        ]
      }
    }
  ];
  const evalResult = runInNewContext(`${patchedPairing};ensureToolResultPairing(mockHistory, {})`, { mockHistory });
  assert.equal(evalResult.length, 2);
  assert.equal(evalResult[0].tool_use_id, 'call_cached');
  assert.equal(evalResult[0].content, 'PASS: suite verified');
  assert.equal(evalResult[0].is_error, false);
  assert.equal(evalResult[1].tool_use_id, 'call_missing');
  assert.equal(evalResult[1].content, '[Tool result missing due to internal error]');
  assert.equal(evalResult[1].is_error, true);

  // Idempotence
  const secondScan = scanAstPatches(patchedPairing)['tool-result-pairing-recovery'];
  assert.equal(secondScan.matches.length, 0);
  assert.equal(secondScan.patched, true);
  assert.equal(secondScan.present, false);

  // Stale detection
  const staleSource = `
    const err = "[Tool result missing due to internal error]";
    function driftedFunction(unrelated) { return unrelated; }
  `;
  const staleScan = scanAstPatches(staleSource)['tool-result-pairing-recovery'];
  assert.equal(staleScan.matches.length, 0);
  assert.equal(staleScan.present, true);
  assert.equal(staleScan.patched, false);
}

// Non-target error generation function negative test:
// A function generating non-missing errors (e.g. permission errors) in the same
// file with sentinel must not be modified, and should be reported as stale.
{
  const nonTargetSource = `
    const sentinel = "[Tool result missing due to internal error]";
    function permissionErrors(history, ids) {
      void history.length;
      return ids.map(item => ({
        type: "tool_result", tool_use_id: item,
        content: "Permission denied", is_error: true
      }));
    }
  `;
  const nonTargetScan = scanAstPatches(nonTargetSource)['tool-result-pairing-recovery'];
  assert.equal(nonTargetScan.matches.length, 0, 'negative case: non-target error function is not matched');
  assert.equal(nonTargetScan.present, true, 'sentinel present in source triggers stale strategy');
  assert.equal(nonTargetScan.patched, false);
}

// Variable collision avoidance tests:
// 1. History parameter renamed to _m: should not emit `for(let _m of _m)` which causes ReferenceError.
{
  const shadowedHistorySource = `
    function ensureToolResultPairing(_m, ids) {
      void _m.length;
      const missingErr = "[Tool result missing due to internal error]";
      return ids.map(item => ({
        type: "tool_result", tool_use_id: item,
        content: missingErr, is_error: true
      }));
    }
  `;
  const scan = scanAstPatches(shadowedHistorySource)['tool-result-pairing-recovery'];
  assert.equal(scan.matches.length, 1);
  const patched = applyAstEdits(shadowedHistorySource, scan.matches);
  parsePatchSource(patched);
  // Ensure we didn't declare let _m of _m
  assert.ok(!patched.includes('for(let _m of _m)'), 'fresh variable avoids history parameter name collision');

  // Must execute without ReferenceError on missing fallback
  const mockHistory = [];
  const evalResult = runInNewContext(`${patched};ensureToolResultPairing(mockHistory, ["call_none"])`, { mockHistory });
  assert.equal(evalResult.length, 1);
  assert.equal(evalResult[0].tool_use_id, 'call_none');
  assert.equal(evalResult[0].content, '[Tool result missing due to internal error]');
  assert.equal(evalResult[0].is_error, true);
}

// 2. Callback parameter renamed to _p: should not emit `(_p)=>{let _p;...}` which causes SyntaxError.
{
  const shadowedCallbackSource = `
    function ensureToolResultPairing(history, ids) {
      void history.length;
      const missingErr = "[Tool result missing due to internal error]";
      return ids.map(_p => ({
        type: "tool_result", tool_use_id: _p,
        content: missingErr, is_error: true
      }));
    }
  `;
  const scan = scanAstPatches(shadowedCallbackSource)['tool-result-pairing-recovery'];
  assert.equal(scan.matches.length, 1);
  const patched = applyAstEdits(shadowedCallbackSource, scan.matches);
  parsePatchSource(patched);
  assert.ok(!patched.includes('(_p)=>{let _p;'), 'fresh variable avoids callback parameter name collision');

  // Must execute and recover correctly
  const mockHistory = [
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_rec', content: 'RECOVERED_OK', is_error: false }]
      }
    }
  ];
  const evalResult = runInNewContext(`${patched};ensureToolResultPairing(mockHistory, ["call_rec", "call_miss"])`, { mockHistory });
  assert.equal(evalResult.length, 2);
  assert.equal(evalResult[0].content, 'RECOVERED_OK');
  assert.equal(evalResult[0].is_error, false);
  assert.equal(evalResult[1].content, '[Tool result missing due to internal error]');
  assert.equal(evalResult[1].is_error, true);
}

// Nested functions and parameter shadowing tests:
// Outer wrapper accessing config[0] must not be mistaken for history array,
// and must not create overlapping edits on inner function's map call.
{
  const nestedSource = `
    function outerWrapper(config) {
      void config[0];
      function ensureToolResultPairing(innerHistory, missingIds) {
        let count = innerHistory.length;
        let defaultErr = "[Tool result missing due to internal error]";
        return missingIds.map(item => ({
          type: "tool_result",
          tool_use_id: item,
          content: defaultErr,
          is_error: !0
        }));
      }
      return ensureToolResultPairing;
    }
  `;
  const scan = scanAstPatches(nestedSource)['tool-result-pairing-recovery'];
  assert.equal(scan.matches.length, 1, 'exactly one match without outer scope claiming inner statement');
  const patched = applyAstEdits(nestedSource, scan.matches); // Throws if overlapping
  parsePatchSource(patched);
  assert.ok(patched.includes('for(let _m of innerHistory)'), 'binds to innerHistory, not outer config');
  assert.ok(!patched.includes('for(let _m of config)'), 'does not bind to outer wrapper parameter');

  const mockHistory = [
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'inner ok', is_error: false }]
      }
    }
  ];
  const evalResult = runInNewContext(`${patched};outerWrapper({})(mockHistory, ["c1", "c2"])`, { mockHistory });
  assert.equal(evalResult.length, 2);
  assert.equal(evalResult[0].content, 'inner ok');
  assert.equal(evalResult[1].content, '[Tool result missing due to internal error]');
}

// End-to-end orphan detection pipeline test:
// Tests a full pairing repair function that models the real upstream deduplication,
// orphan check, and synthesis logic.
// Validates:
// 1. Before patch: synthesis injects missing errors for missing tool results.
// 2. After patch: recovers authentic results from message history.
// 3. True failure preservation: real errors retain is_error: true and original error content.
// 4. Fallback: unseen tool_use correctly synthesizes missing error.
// 5. Pairing constraints: every assistant tool_use has exactly one tool_result in the following user message.
{
  const fullPairingSource = `
    const SENTINEL = "[Tool result missing due to internal error]";
    function ensureToolResultPairing(messages) {
      let repaired = [];
      let modified = false;
      let seen = new Set();
      for (let i = 0; i < messages.length; i++) {
        let msg = messages[i];
        if (msg.type !== "assistant") {
          repaired.push(msg);
          continue;
        }
        let assistantIds = new Set();
        let valid = msg.message.content.filter(b => {
          if (b.type === "tool_use") {
            if (seen.has(b.id)) { modified = true; return false; }
            seen.add(b.id);
            assistantIds.add(b.id);
          }
          return true;
        });
        repaired.push(valid.length !== msg.message.content.length ? { ...msg, message: { ...msg.message, content: valid } } : msg);
        let nextMsg = messages[i + 1];
        let userIds = new Set();
        if (nextMsg?.type === "user" && Array.isArray(nextMsg.message.content)) {
          for (let b of nextMsg.message.content) {
            if (b?.type === "tool_result") userIds.add(b.tool_use_id);
          }
        }
        let missing = [...assistantIds].filter(id => !userIds.has(id));
        let unexpected = [...userIds].filter(id => !assistantIds.has(id));
        if (missing.length === 0 && unexpected.length === 0) continue;
        modified = true;
        let synthetic = missing.map(id => ({
          type: "tool_result",
          tool_use_id: id,
          content: SENTINEL,
          is_error: true
        }));
        if (nextMsg?.type === "user") {
          let content = Array.isArray(nextMsg.message.content) ? nextMsg.message.content : [{ type: "text", text: nextMsg.message.content }];
          if (unexpected.length > 0) {
            let unexpSet = new Set(unexpected);
            content = content.filter(b => !(b?.type === "tool_result" && unexpSet.has(b.tool_use_id)));
          }
          i++;
          repaired.push({ ...nextMsg, message: { ...nextMsg.message, content: [...synthetic, ...content] } });
        } else if (synthetic.length > 0) {
          repaired.push({ type: "user", message: { content: synthetic } });
        }
      }
      return modified ? repaired : messages;
    }
  `;

  // Realistic sanitized sequence:
  // Turn 1:
  // assistant calls fetch_spec.
  // user returns fetch_spec result, AND pre-delivers concurrent results for run_batch (success)
  // and lint_check (failure: exit code 1) from parallel execution.
  // Turn 2:
  // assistant plans next step and emits run_batch, lint_check, and a totally fresh build_final.
  // user responds with plain text "continue", missing results in immediate next turn.
  const sampleMessages = [
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call_fetch', name: 'fetch_spec', input: {} }]
      }
    },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'call_fetch', content: 'SPEC CONTENT OK', is_error: false },
          { type: 'tool_result', tool_use_id: 'call_batch', content: 'PASS: 42 batch tests executed', is_error: false },
          { type: 'tool_result', tool_use_id: 'call_lint', content: 'exit code 1: trailing whitespace in parser.js', is_error: true }
        ]
      }
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'call_batch', name: 'run_batch', input: {} },
          { type: 'tool_use', id: 'call_lint', name: 'lint_check', input: {} },
          { type: 'tool_use', id: 'call_build', name: 'build_final', input: {} }
        ]
      }
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'text', text: 'continue' }]
      }
    }
  ];

  // 1. Verify unpatched baseline: injects synthetic missing errors
  const unpatchedResult = runInNewContext(`${fullPairingSource};ensureToolResultPairing(sampleMessages)`, {
    sampleMessages: structuredClone(sampleMessages)
  });
  const unpatchedTurn2User = unpatchedResult[3];
  const unpatchedBatchResult = unpatchedTurn2User.message.content.find(b => b.tool_use_id === 'call_batch');
  const unpatchedLintResult = unpatchedTurn2User.message.content.find(b => b.tool_use_id === 'call_lint');
  const unpatchedBuildResult = unpatchedTurn2User.message.content.find(b => b.tool_use_id === 'call_build');

  assert.equal(unpatchedBatchResult.content, '[Tool result missing due to internal error]', 'unpatched injects missing error');
  assert.equal(unpatchedBatchResult.is_error, true);
  assert.equal(unpatchedLintResult.content, '[Tool result missing due to internal error]', 'unpatched overwrites real lint error');
  assert.equal(unpatchedBuildResult.content, '[Tool result missing due to internal error]');

  // 2. Scan and patch full pairing function
  const scan = scanAstPatches(fullPairingSource)['tool-result-pairing-recovery'];
  assert.equal(scan.matches.length, 1);
  const patched = applyAstEdits(fullPairingSource, scan.matches);
  parsePatchSource(patched);

  // 3. Verify patched execution
  const patchedResult = runInNewContext(`${patched};ensureToolResultPairing(sampleMessages)`, {
    sampleMessages: structuredClone(sampleMessages)
  });
  const patchedTurn2User = patchedResult[3];
  const patchedBatchResult = patchedTurn2User.message.content.find(b => b.tool_use_id === 'call_batch');
  const patchedLintResult = patchedTurn2User.message.content.find(b => b.tool_use_id === 'call_lint');
  const patchedBuildResult = patchedTurn2User.message.content.find(b => b.tool_use_id === 'call_build');

  // Verify successful result recovery
  assert.equal(patchedBatchResult.content, 'PASS: 42 batch tests executed', 'recovers authentic success result');
  assert.equal(patchedBatchResult.is_error, false);

  // Verify authentic failure state preservation
  assert.equal(patchedLintResult.content, 'exit code 1: trailing whitespace in parser.js', 'preserves real error description');
  assert.equal(patchedLintResult.is_error, true, 'strictly preserves authentic failure state (is_error: true)');

  // Verify missing fallback
  assert.equal(patchedBuildResult.content, '[Tool result missing due to internal error]', 'fallback to synthesized error when truly absent');
  assert.equal(patchedBuildResult.is_error, true);

  // 4. Verify Anthropic API pairing constraints
  for (let i = 0; i < patchedResult.length; i++) {
    const msg = patchedResult[i];
    if (msg.type === 'assistant') {
      const next = patchedResult[i + 1];
      assert.ok(next && next.type === 'user', 'every assistant message must be followed by a user message');
      const toolUses = msg.message.content.filter(b => b.type === 'tool_use');
      const toolResults = next.message.content.filter(b => b.type === 'tool_result');
      const resultIdSet = new Set(toolResults.map(r => r.tool_use_id));
      for (const tu of toolUses) {
        assert.ok(resultIdSet.has(tu.id), `every tool_use (${tu.id}) has a corresponding tool_result`);
      }
    }
  }
}

// Same-spelled identifiers must resolve to their actual lexical bindings.
{
  const sentinel = '[Tool result missing due to internal error]';
  const object = '{type:"tool_result",tool_use_id:item,content:err,is_error:true}';
  const map = `ids.map(item=>(${object}))`;
  const outer = `const err=${JSON.stringify(sentinel)};`;
  for (const source of [
    `${outer}function pairing(history,ids){void history.length;const err="Permission denied";return ${map}}`,
    `${outer}function pairing(history,ids,err){void history.length;return ${map}}`,
    `${outer}function pairing(history,ids){void history.length;{const err="Permission denied";return ${map}}}`,
    `${outer}function pairing(history,ids){void history.length;try{throw "Permission denied"}catch(err){return ${map}}}`,
    `function other(){const err=${JSON.stringify(sentinel)}}function pairing(history,ids){void history.length;const err="Permission denied";return ${map}}`,
    `let err=${JSON.stringify(sentinel)};err="Permission denied";function pairing(history,ids){void history.length;return ${map}}`,
    `${outer}function pairing(history,ids){void history.length;{const history={};return ${map}}}`,
    `${outer}function pairing(history,ids){void history.length;return ids.map(item=>{const err=${JSON.stringify(sentinel)};return ${object}})}`,
    `${outer}function pairing(history,ids){void history.length;return ids.map(item=>{record(item);return ${object}})}`,
    `${outer}function pairing(history,ids){void history.length;return ids.map(item=>({...${object},metadata:42}))}`,
  ]) {
    const result = scanAstPatches(source)['tool-result-pairing-recovery'];
    assert.equal(result.matches.length, 0, source);
    assert.equal(result.present, true, 'unsupported bindings and callback bodies must be stale');
    assert.equal(applyAstEdits(source, result.matches), source);
  }

  // Both declaration initializers and Bun-style deferred assignments are supported.
  for (const declaration of [outer, `var err;function initialize(){err=${JSON.stringify(sentinel)}}initialize();`]) {
    for (const callback of [`item=>(${object})`, `function(item){return ${object}}`]) {
      const source = `${declaration}function pairing(history,ids){void history.length;return ids.map(${callback})}`;
      const result = scanAstPatches(source)['tool-result-pairing-recovery'];
      assert.equal(result.matches.length, 1);
      const patched = applyAstEdits(source, result.matches);
      parsePatchSource(patched);
      const history = [{type:'user',message:{content:[{type:'tool_result',tool_use_id:'cached',content:'real output',is_error:false}]}}];
      const recovered = runInNewContext(`${patched};pairing(history,['cached','missing'])`, {history});
      assert.equal(recovered[0].content, 'real output');
      assert.equal(recovered[1].content, sentinel);
    }
  }

  // The original map parameter may legally reuse the history parameter's name.
  const source = `${outer}function pairing(history,ids){void history.length;return ids.map(history=>({type:"tool_result",tool_use_id:history,content:err,is_error:true}))}`;
  const result = scanAstPatches(source)['tool-result-pairing-recovery'];
  assert.equal(result.matches.length, 1);
  const patched = applyAstEdits(source, result.matches);
  parsePatchSource(patched);
  const history = [{type:'user',message:{content:[
    {type:'tool_result',tool_use_id:'cached',content:'real output',is_error:false},
    {type:'tool_result',tool_use_id:'failed',content:'exit code 1',is_error:true},
  ]}}];
  for (const enabled of [true, false]) {
    const recovered = runInNewContext(`${patched};pairing(history,['cached','failed','missing'])`, {
      history, __clawgodPatches: {'tool-result-pairing-recovery':enabled},
    });
    assert.equal(recovered[0].content, enabled ? 'real output' : sentinel);
    assert.equal(recovered[0].is_error, !enabled);
    assert.equal(recovered[1].content, enabled ? 'exit code 1' : sentinel);
    assert.equal(recovered[1].is_error, true);
    assert.equal(recovered[2].content, sentinel);
  }
  assert.equal(scanAstPatches(patched)['tool-result-pairing-recovery'].patched, true);
}

console.log('[ast-patches.test] semantic ranges, gates, drift, backups and failure safety passed');
