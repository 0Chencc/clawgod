import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { AST_PATCH_IDS, scanAstPatches, applyAstEdits, parsePatchSource, transformAstPatches } from './ast-patches.mjs';
import { defineModules, runModules, verifyModule } from './ast/engine.mjs';

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
  ['remote-settings-off', 'wiggly-dove', 'tool-result-pairing-recovery', 'auto-mode-inline-gate'].includes(id) ? 0 : 1, id);
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

// 2.1.323/325 split the provider restriction across an if and a final return.
const autoModeSource = `
function thirdParty(){const route=provider;return route!=='firstParty'&&!aws(route)}
function aws(route){return route==='anthropicAws'}
function supports(input){
  const model=input;
  if(tooOld(model))return false;
  let restricted=thirdParty();
  if(restricted&&(model==='claude-opus-4-6'||model==='claude-sonnet-4-6')){return false;}
  const localRestriction=provider==='firstParty'&&firstPartyRestricted;
  return !((restricted||localRestriction)&&model.includes('haiku')&&model!=='claude-haiku-5-5');
}
function neighbor(){return thirdParty()}
`;
const autoId = 'auto-mode-inline-gate';
const autoScan = scanAstPatches(autoModeSource)[autoId];
assert.equal(autoScan.matches.length, 1);
const autoPatched = applyAstEdits(autoModeSource, autoScan.matches);
parsePatchSource(autoPatched);
assert.equal(scanAstPatches(autoPatched)[autoId].matches.length, 0);
assert.equal(scanAstPatches(autoPatched)[autoId].patched, true);
assert.ok(autoPatched.includes('function neighbor(){return thirdParty()}'));
for (const toggle of [undefined, true, false]) {
  for (const provider of ['firstParty', 'anthropicAws', 'proxy']) {
    for (const firstPartyRestricted of [false, true]) {
      for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-5-5', 'new-model', 'too-old']) {
        const context = { provider, firstPartyRestricted, tooOld: value => value === 'too-old',
          __clawgodPatches: { [autoId]: toggle } };
        const original = runInNewContext(`${autoModeSource};supports(${JSON.stringify(model)})`, context);
        const actual = runInNewContext(`${autoPatched};supports(${JSON.stringify(model)})`, context);
        const expected = toggle !== false && provider === 'proxy' ? model !== 'too-old' : original;
        assert.equal(actual, expected, `${provider}, ${model}, toggle=${toggle}, local=${firstPartyRestricted}`);
        assert.equal(runInNewContext(`${autoPatched};neighbor()`, context), provider === 'proxy');
      }
    }
  }
}
for (const changed of [
  autoModeSource.replace('let restricted=thirdParty();', 'let restricted=unknown();'),
  autoModeSource.replace('let restricted=thirdParty();', 'let restricted=thirdParty();restricted=unknown();'),
]) {
  const result = scanAstPatches(changed)[autoId];
  assert.equal(result.present, true, 'unknown predicates must fail closed');
  assert.equal(result.matches.length, 0);
}
for (const decoy of [
  `function ordinary(){return provider!=="firstParty"&&provider!=="gateway"}`,
  `const sample=${JSON.stringify(autoModeSource)};`,
  `/* ${autoModeSource} */`,
]) {
  const result = scanAstPatches(decoy)[autoId];
  assert.equal(result.present, false, 'unrelated provider checks and text are not stale auto-mode gates');
  assert.equal(result.matches.length, 0);
}

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
// Zero-width edits at distinct offsets keep their offsets regardless of order.
assert.equal(applyAstEdits('abcd', [
  { start: 3, end: 3, replacement: 'Y' }, { start: 1, end: 1, replacement: 'X' },
]), 'aXbcYd');
// An insert at a replacement's start boundary sorts before the replacement.
assert.equal(applyAstEdits('abcd', [
  { start: 1, end: 3, replacement: 'R' }, { start: 1, end: 1, replacement: 'I' },
]), 'aIRd');

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
    cpSync(new URL('./ast', import.meta.url), join(dir, 'ast'), { recursive: true });
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
}

// Negative cases with the sentinel present: a drifted site and a non-target
// error generator (e.g. permission errors) must stay untouched, and are
// reported as stale rather than patched.
for (const source of [
  `const err = "[Tool result missing due to internal error]";
   function driftedFunction(unrelated) { return unrelated; }`,
  `const sentinel = "[Tool result missing due to internal error]";
   function permissionErrors(history, ids) {
     void history.length;
     return ids.map(item => ({
       type: "tool_result", tool_use_id: item,
       content: "Permission denied", is_error: true
     }));
   }`,
]) {
  const scan = scanAstPatches(source)['tool-result-pairing-recovery'];
  assert.equal(scan.matches.length, 0);
  assert.equal(scan.present, true);
  assert.equal(scan.patched, false);
}

// Variable collision avoidance: the generated helper must not reuse the
// history parameter or the map callback parameter as its own binding, which
// would produce `for(let _m of _m)` (ReferenceError) or `(_p)=>{let _p;...}`
// (SyntaxError).
{
  const cases = [
    ['history parameter', `function ensureToolResultPairing(_m, ids) {
      void _m.length;
      const missingErr = "[Tool result missing due to internal error]";
      return ids.map(item => ({
        type: "tool_result", tool_use_id: item,
        content: missingErr, is_error: true
      }));
    }`, 'for(let _m of _m)'],
    ['callback parameter', `function ensureToolResultPairing(history, ids) {
      void history.length;
      const missingErr = "[Tool result missing due to internal error]";
      return ids.map(_p => ({
        type: "tool_result", tool_use_id: _p,
        content: missingErr, is_error: true
      }));
    }`, '(_p)=>{let _p;'],
  ];
  for (const [label, source, forbidden] of cases) {
    const scan = scanAstPatches(source)['tool-result-pairing-recovery'];
    assert.equal(scan.matches.length, 1, label);
    const patched = applyAstEdits(source, scan.matches);
    parsePatchSource(patched);
    assert.ok(!patched.includes(forbidden), `${label}: fresh variable avoids the collision`);
    // Must execute: recover the authentic result and synthesize the missing one.
    const mockHistory = [{
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_rec', content: 'RECOVERED_OK', is_error: false }]
      }
    }];
    const evalResult = runInNewContext(`${patched};ensureToolResultPairing(mockHistory, ["call_rec", "call_miss"])`, { mockHistory });
    assert.equal(evalResult.length, 2, label);
    assert.equal(evalResult[0].content, 'RECOVERED_OK', label);
    assert.equal(evalResult[0].is_error, false, label);
    assert.equal(evalResult[1].content, '[Tool result missing due to internal error]', label);
    assert.equal(evalResult[1].is_error, true, label);
  }
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

// Module engine protocol: startup validation, anchor gating, ownership and
// stale semantics. Exercised directly because the integration fixtures only
// reach the happy path.
{
  const probeModule = (overrides = {}) => ({ id: 'probe', anchors: ['probe-anchor'], scan() {}, ...overrides });
  for (const [label, entries, pattern, ids = ['probe'], legacyAnchors = ['probe-anchor']] of [
    ['unknown export', [probeModule({ extra: true })], /unsupported name 'extra'/],
    ['missing fields', [{ id: 'probe', anchors: ['probe-anchor'] }], /must export id, anchors and scan/],
    ['scan not a function', [probeModule({ scan: undefined })], /must export scan/],
    ['empty id', [probeModule({ id: '' })], /non-empty string id/],
    ['inherited fields', [Object.create(probeModule())], /must export id, anchors and scan/],
    ['sparse anchors', [probeModule({ anchors: Array(3) })], /anchors array/],
    ['unlisted id', [probeModule()], /not listed in AST_PATCH_IDS/, ['other-id']],
    ['new anchor widens the prefilter', [probeModule({ anchors: ['other-anchor'] })],
      /not in the legacy anchors list/, ['probe'], ['probe-anchor']],
    ['duplicate id', [probeModule(), probeModule()], /duplicate AST patch id/],
    ['verify not a function', [probeModule({ verify: true })], /must export verify as a function/],
  ]) {
    assert.throws(() => defineModules(entries, ids, legacyAnchors), pattern, label);
  }
  defineModules([probeModule()], ['probe'], ['probe-anchor']);
  // Empty anchors are valid and mean "no prefilter".
  defineModules([probeModule({ anchors: [] })], ['probe'], ['probe-anchor']);
  // verify is optional, but once exported it is part of the module contract.
  defineModules([probeModule({ verify: () => true })], ['probe'], ['probe-anchor']);
  assert.equal(verifyModule({ id: 'probe', verify: () => true }, {}), true);
  assert.equal(verifyModule({ id: 'probe', verify: () => 'truthy' }, {}), false,
    'only a strict true proves completion');
  assert.throws(() => verifyModule({ id: 'probe' }, {}), /exports no verify/);

  const tree = parsePatchSource('function outer(){return 1}');
  const dispatch = (code, scan, anchors = ['probe-anchor']) => {
    const results = { probe: { matches: [], present: false, patched: false } };
    const seen = [];
    runModules({
      code, tree, functions: new Map(), results,
      modules: [{
        id: 'probe', anchors,
        scan(ctx) {
          seen.push(ctx.nodes('FunctionDeclaration').length, Object.isFrozen(ctx.nodes('FunctionDeclaration')));
          scan?.(ctx);
        },
      }],
    });
    return { result: results.probe, seen };
  };

  // Anchor absent: no dispatch.
  assert.deepEqual(dispatch('nothing here'), { result: { matches: [], present: false, patched: false }, seen: [] });

  // Empty anchors skip the prefilter: dispatch even without any anchor.
  assert.deepEqual(dispatch('nothing here', undefined, []).seen, [1, true]);

  // Anchor present: nodes come from one frozen index, in traversal order.
  assert.deepEqual(dispatch('probe-anchor').seen, [1, true]);

  // stale discards collected edits and ignores later edits.
  const staled = dispatch('probe-anchor', ctx => {
    ctx.edit(ctx.tree.body[0], 'first');
    ctx.stale(ctx.tree.body[0], 'drifted');
    ctx.edit(ctx.tree.body[0], 'second');
  });
  assert.deepEqual(staled.result.matches, []);
  assert.equal(staled.result.stale.reason, 'drifted');
  assert.equal(staled.result.present, true,
    'stale must surface as present, or the runner skips the drift');

  // A leftover inline branch for the same id fails loudly instead of double-writing.
  const leftover = { matches: [], present: false, patched: true };
  assert.throws(() => runModules({
    code: 'probe-anchor', tree, functions: new Map(), results: { probe: leftover },
    modules: [{ id: 'probe', anchors: ['probe-anchor'], scan() {} }],
  }), /already written by the inline scan/);
}

// Dual-track entry behavior. Fixture modules are injected through the second
// scanAstPatches argument, so they never enter the production MODULES table.
{
  const programEdit = replacement => ({
    id: 'user-type-ant', anchors: [],
    scan({ nodes, edit }) { for (const node of nodes('Program')) edit(node, replacement); },
  });

  // Empty source: no legacy anchor, yet the empty-anchor module runs. Every
  // other id keeps its initial empty result.
  const empty = scanAstPatches('', [programEdit('/*fixture*/')]);
  assert.deepEqual(empty['user-type-ant'].matches, [{ start: 0, end: 0, replacement: '/*fixture*/' }]);
  for (const id of AST_PATCH_IDS) {
    if (id === 'user-type-ant') continue;
    assert.deepEqual(empty[id], { matches: [], present: false, patched: false }, id);
  }

  // Auto-mode gate text without any legacy anchor: the module sees the parsed
  // tree and functions, while the inline track stays disabled and must not
  // report the gate as patched.
  const gateOnly = 'function gated(){return globalThis.__clawgodPatches?.["auto-mode-inline-gate"]}';
  const calls = [];
  const isolated = scanAstPatches(gateOnly, [{
    id: 'user-type-ant', anchors: [], scan(ctx) { calls.push(ctx); },
  }]);
  assert.equal(calls.length, 1, 'empty anchors dispatch on every parsed file');
  assert.ok(calls[0].functions.size > 0, 'modules share the functions table');
  assert.equal(calls[0].nodes('Program').length, 1);
  assert.deepEqual(isolated['auto-mode-inline-gate'], { matches: [], present: false, patched: false },
    'the inline track must not run without legacy anchors');

  // Non-empty anchors still gate the module at entry level.
  const gatedModule = {
    id: 'user-type-ant', anchors: ['fixture-anchor'],
    scan({ nodes, edit }) { for (const node of nodes('Program')) edit(node, 'gated'); },
  };
  assert.deepEqual(scanAstPatches('const value = 1;', [gatedModule])['user-type-ant'].matches, []);
  assert.equal(scanAstPatches("const value = 'fixture-anchor';", [gatedModule])['user-type-ant'].matches.length, 1);

  // A narrow raw-text anchor misses decoded literals with escapes. The
  // migrated module keeps the full prefilter, so it stays on exactly the
  // files the inline branch saw.
  const escapedAnt = "var mode='remote-settings.json';function userType(){return\"\\x65xternal\"}";
  assert.equal(scanAstPatches(escapedAnt)['user-type-ant'].matches.length, 1);
  // Without any legacy anchor the file is still not parsed, as before.
  assert.equal(scanAstPatches('function userType(){return"\\x65xternal"}')['user-type-ant'].matches.length, 0);
}

// Combination (unit C). Fixture modules borrow real AST_PATCH_IDS so the
// temp-copy runner accepts them through defineModules; the production
// MODULES table is never extended. Scans are written to settle themselves:
// a fixture that keeps matching its own output fails the idempotency rescan.
{
  const isLiteralReturn = (fn, value) => {
    const statement = fn.body?.body?.[0];
    return statement?.type === 'ReturnStatement' && statement.argument?.type === 'Literal' &&
      statement.argument.value === value;
  };
  // Whole-node replacement: adds a parameter to the zero-arg f().
  const addParameter = {
    id: 'ultraplan', anchors: [],
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name !== 'f' || fn.params.length || !isLiteralReturn(fn, 1)) continue;
        edit(fn, 'function f(x){return 1}');
      }
    },
    verify: ({ after, matches }) => matches.length === 1 && after.code.includes('function f(x){'),
  };
  // Child-node replacement: every `return 1` becomes `return 2`.
  const returnTwo = {
    id: 'voice-mode', anchors: [],
    scan({ nodes, edit }) {
      for (const statement of nodes('ReturnStatement')) {
        const argument = statement.argument;
        if (argument?.type === 'Literal' && argument.value === 1) edit(argument, '2');
      }
    },
    verify: ({ after }) => !after.code.includes('return 1') && after.code.includes('return 2'),
  };
  // Same child edit, restricted to g(), so it does not overlap addParameter.
  const returnTwoInG = {
    ...returnTwo,
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name !== 'g') continue;
        const argument = fn.body?.body?.[0]?.argument;
        if (argument?.type === 'Literal' && argument.value === 1) edit(argument, '2');
      }
    },
    verify: ({ after }) => after.code.includes('function g(){return 2}'),
  };

  // 1. Composition: the later id sees the earlier layer and settles on it.
  const composed = transformAstPatches('function f(){return 1}', [addParameter, returnTwo]);
  assert.equal(composed.conflict, null);
  assert.equal(composed.code, 'function f(x){return 2}');
  assert.equal(composed.results.ultraplan.applied, 1);
  assert.equal(composed.results['voice-mode'].applied, 1);
  const settled = transformAstPatches(composed.code, [addParameter, returnTwo]);
  assert.equal(settled.conflict, null);
  assert.equal(settled.code, composed.code, 'a settled composition must not change again');
  assert.equal(settled.results.ultraplan.applied + settled.results['voice-mode'].applied, 0);

  // 2. A rewrite that removes B's target must not pass as "nothing to do".
  const eraseTarget = {
    id: 'ultraplan', anchors: [],
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name === 'f' && !fn.params.length && isLiteralReturn(fn, 1)) edit(fn, 'function f(){}');
      }
    },
    verify: ({ after }) => after.code.includes('function f(){}'),
  };
  const lost = transformAstPatches('function f(){return 1}', [eraseTarget, returnTwo]);
  assert.deepEqual(lost.conflict, { ids: ['voice-mode'], reason: 'lost or unverified target' });
  assert.equal(lost.code, 'function f(){return 1}', 'a refused combination returns the original text');
  // A participant with no effective edit on its layer is not silently
  // completed: it stays pending while later ids still run, and its verify
  // decides the outcome.
  const tolerantReturn = {
    id: 'voice-mode', anchors: [],
    scan: returnTwo.scan,
    verify: ({ after }) => !after.code.includes('return 1'),
  };
  const laterInsert = {
    id: 'geo-stego-date', anchors: [],
    scan({ code, edit }) {
      if (!code.includes('/*c*/')) edit({ start: 0, end: 0 }, '/*c*/');
    },
    verify: ({ after }) => after.code.includes('/*c*/'),
  };
  const continued = transformAstPatches('function f(){return 1}', [eraseTarget, tolerantReturn, laterInsert]);
  assert.equal(continued.conflict, null);
  assert.equal(continued.code, '/*c*/function f(){}');
  assert.equal(continued.results['voice-mode'].applied, 0, 'a vanished mid-layer target stays unapplied');

  // 3. Every layered participant must prove itself before anything applies.
  const withoutVerify = { id: 'voice-mode', anchors: [], scan: returnTwo.scan };
  const unproven = transformAstPatches('function f(){return 1}', [eraseTarget, withoutVerify]);
  assert.deepEqual(unproven.conflict, { ids: ['voice-mode'], reason: 'module has no verify' });
  assert.equal(unproven.code, 'function f(){return 1}');
  assert.equal(unproven.results.ultraplan.applied, 0, 'no layer runs when a participant is refused');
  const legacySource = "var rollout='tengu_wiggly_dove';" +
    'function allowed(){if(!firstParty())return false;if(!lookup(rollout,false))return false;return routeAllowed();}';
  const overwriteAllowed = {
    id: 'ultraplan', anchors: [], verify: () => true,
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name === 'allowed') edit(fn, 'function allowed(){}');
      }
    },
  };
  const legacy = transformAstPatches(legacySource, [overwriteAllowed]);
  assert.deepEqual(legacy.conflict, { ids: ['wiggly-dove'], reason: 'legacy patch cannot participate in combination' });

  // 4. One id's sites form a single group: both apply on the same layer.
  const grouped = transformAstPatches('function f(){return 1}function g(){return 1}', [addParameter, returnTwo]);
  assert.equal(grouped.conflict, null);
  assert.equal(grouped.code, 'function f(x){return 2}function g(){return 2}');
  assert.equal(grouped.results.ultraplan.applied, 1);
  assert.equal(grouped.results['voice-mode'].applied, 2, 'the whole group applies together');
  // Self-overlap is that id's implementation error, never a conflict.
  const selfOverlap = {
    id: 'ultraplan', anchors: [],
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) { edit(fn, 'X'); edit(fn.body, 'Y'); }
    },
  };
  assert.throws(() => transformAstPatches('function f(){return 1}', [selfOverlap]),
    /AST patch 'ultraplan' produced overlapping edits/);
  // Same-offset zero-width edits inside one group are rejected the same way.
  const duplicatedInsert = {
    id: 'ultraplan', anchors: [],
    scan({ edit }) { edit({ start: 0, end: 0 }, 'A'); edit({ start: 0, end: 0 }, 'B'); },
  };
  assert.throws(() => transformAstPatches('var x=1;', [duplicatedInsert]),
    /AST patch 'ultraplan' produced overlapping edits/);
  // The runner-facing scan does not compose a single id's self-overlap: the
  // raw matches pass through and the applicator rejects them later, exactly
  // as the pre-migration path did.
  assert.equal(scanAstPatches('function f(){return 1}', [selfOverlap]).ultraplan.matches.length, 2);
  assert.deepEqual(scanAstPatches('var x=1;', [duplicatedInsert]).ultraplan.matches.map(m => m.replacement),
    ['A', 'B']);
  // A cross-id overlap forces combination, so every initial group is checked
  // first: a self-overlapping module cannot be rescued by a later layer.
  const mixedSelfOverlap = {
    id: 'voice-mode', anchors: [], verify: () => true,
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name !== 'f') continue;
        if (fn.params.length) edit(fn.body.body[0].argument, '2');
        else { edit(fn.body, '{}'); edit(fn.body.body[0], 'return 0'); }
      }
    },
  };
  assert.throws(() => transformAstPatches('function f(){return 1}', [addParameter, mixedSelfOverlap]),
    /AST patch 'voice-mode' produced overlapping edits/);
  assert.throws(() => scanAstPatches('function f(){return 1}', [addParameter, mixedSelfOverlap]),
    /AST patch 'voice-mode' produced overlapping edits/);
  // The check repeats on every layer, not only on the initial scan.
  const splitsOnlyLater = {
    id: 'voice-mode', anchors: [], verify: () => true,
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name !== 'f') continue;
        if (!fn.params.length) edit(fn.body.body[0].argument, '2');
        else { edit(fn.body, '{}'); edit(fn.body.body[0], 'return 0'); }
      }
    },
  };
  const overlapsLater = {
    id: 'ultraplan', anchors: [], verify: ({ after }) => after.code.includes('function f(x){'),
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name === 'f' && !fn.params.length) edit(fn, 'function f(x){return 1}');
      }
    },
  };
  assert.throws(() => transformAstPatches('function f(){return 1}', [overlapsLater, splitsOnlyLater]),
    /AST patch 'voice-mode' produced overlapping edits/);

  // 5. Two empty-anchor Program modules apply once each, in id order.
  const prependInit = {
    id: 'geo-stego-date', anchors: [],
    scan({ code, nodes, edit }) {
      if (code.includes('var a=1')) return;
      for (const program of nodes('Program')) edit(program, `var a=1;${code.slice(program.start, program.end)}`);
    },
    verify: ({ after }) => after.code.includes('var a=1'),
  };
  const appendInit = {
    id: 'remote-settings-off', anchors: [],
    scan({ code, nodes, edit }) {
      if (code.includes('var b=2')) return;
      for (const program of nodes('Program')) edit(program, `${code.slice(program.start, program.end)};var b=2`);
    },
    verify: ({ after }) => after.code.includes('var b=2'),
  };
  const initialized = transformAstPatches('var x=1;', [prependInit, appendInit]);
  assert.equal(initialized.conflict, null);
  assert.equal(initialized.code, 'var a=1;var x=1;;var b=2');
  assert.equal(initialized.results['geo-stego-date'].applied, 1);
  assert.equal(initialized.results['remote-settings-off'].applied, 1);
  // A module that keeps matching its own output fails the rescan.
  const unguardedInit = {
    id: 'remote-settings-off', anchors: [], verify: () => true,
    scan({ code, nodes, edit }) {
      for (const program of nodes('Program')) edit(program, `/*c*/${code.slice(program.start, program.end)}`);
    },
  };
  const unstable = transformAstPatches('var x=1;', [prependInit, unguardedInit]);
  assert.deepEqual(unstable.conflict, { ids: ['remote-settings-off'], reason: 'idempotency check failed' });
  assert.equal(unstable.code, 'var x=1;');
  // A participant whose matcher goes stale on the final text is not settled
  // either: the next run would refuse the file instead of skipping it.
  const staleAfterCombine = {
    id: 'voice-mode', anchors: [], verify: () => true,
    scan({ code, nodes, edit, stale }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (code.includes('function f(x)')) { stale(fn, 'drift'); return; }
        if (!fn.params.length) edit(fn.body.body[0].argument, '2');
      }
    },
  };
  const staleRescan = transformAstPatches('function f(){return 1}', [addParameter, staleAfterCombine]);
  assert.deepEqual(staleRescan.conflict, { ids: ['voice-mode'], reason: 'idempotency check failed' });
  assert.equal(staleRescan.code, 'function f(){return 1}');
  assert.throws(() => scanAstPatches('function f(){return 1}', [addParameter, staleAfterCombine]),
    /AST combination conflict: idempotency check failed \(voice-mode\)/);

  // 5b. Same-offset zero-width edits from two ids are ordered by layer.
  const insertBefore = id => ({
    id, anchors: [],
    scan({ code, edit }) {
      if (!code.includes(`/*${id}*/`)) edit({ start: 0, end: 0 }, `/*${id}*/`);
    },
    verify: ({ after }) => after.code.includes(`/*${id}*/`),
  });
  const ordered = transformAstPatches('var x=1;', [insertBefore('geo-stego-date'), insertBefore('remote-settings-off')]);
  assert.equal(ordered.conflict, null);
  assert.equal(ordered.code, '/*remote-settings-off*//*geo-stego-date*/var x=1;',
    'a later id inserts at the same offset after the earlier layer');

  // 6. An id with no initial edit never runs, even when a layer creates a
  // match for it.
  const awaken = {
    id: 'geo-stego-date', anchors: [],
    scan({ nodes, edit }) {
      for (const statement of nodes('ReturnStatement')) {
        if (statement.argument?.type === 'Literal' && statement.argument.value === 3) edit(statement.argument, '4');
      }
    },
  };
  const rewriteBody = {
    id: 'ultraplan', anchors: [],
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name === 'f' && !fn.params.length && isLiteralReturn(fn, 1)) edit(fn, 'function f(){return 3}');
      }
    },
    verify: ({ after }) => after.code.includes('return 3'),
  };
  const touchReturn = {
    id: 'voice-mode', anchors: [],
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name === 'f' && isLiteralReturn(fn, 1)) edit(fn.body.body[0], 'return 1;void 0');
      }
    },
    verify: ({ after }) => !after.code.includes('return 1'),
  };
  const awake = transformAstPatches('function f(){return 1}', [rewriteBody, touchReturn, awaken]);
  assert.equal(awake.conflict, null, 'a non-participant match is ignored, not an error');
  assert.equal(awake.code, 'function f(){return 3}');
  assert.equal(awake.results['geo-stego-date'].applied, 0);

  // 7. Without cross-id overlap the transform matches the historical
  // collect-then-apply path byte for byte.
  const splitSource = 'function f(){return 1}function g(){return 1}';
  const historical = Object.values(scanAstPatches(splitSource, [addParameter, returnTwoInG]))
    .flatMap(result => result.matches)
    .filter(match => match.replacement !== splitSource.slice(match.start, match.end));
  const fast = transformAstPatches(splitSource, [addParameter, returnTwoInG]);
  assert.equal(fast.conflict, null);
  assert.equal(fast.code, applyAstEdits(splitSource, historical));
  assert.equal(fast.code, 'function f(x){return 1}function g(){return 2}');
  assert.equal(fast.results.ultraplan.applied, 1);
  assert.equal(fast.results['voice-mode'].applied, 1);

  // 8. The runner-facing scan folds a composition into one whole-file edit on
  // the first participant. Later participants keep their matches as no-ops so
  // a `present` id never falls into the old runner's stale branch, and the
  // historical flush still applies exactly one edit.
  const runnerSource = 'function f(){return 1}';
  const runnerScan = scanAstPatches(runnerSource, [addParameter, returnTwo]);
  assert.deepEqual(runnerScan.ultraplan.matches,
    [{ start: 0, end: runnerSource.length, replacement: 'function f(x){return 2}' }]);
  assert.equal(runnerScan['voice-mode'].matches.length, 1);
  const secondary = runnerScan['voice-mode'].matches[0];
  assert.equal(secondary.replacement, runnerSource.slice(secondary.start, secondary.end),
    'secondary participant edits collapse to no-ops');
  assert.equal(applyAstEdits(runnerSource, Object.values(runnerScan).flatMap(r =>
    r.matches.filter(m => m.replacement !== runnerSource.slice(m.start, m.end)))),
    'function f(x){return 2}');
}

// Combination through the real runner: each temp copy appends fixture modules
// to its own MODULES table, so the production table stays untouched.
{
  const root = mkdtempSync(join(tmpdir(), 'clawgod-combination-test-'));
  const successFixture = `
export const modules = [
  {
    id: 'ultraplan', anchors: [],
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name !== 'f' || fn.params.length) continue;
        const statement = fn.body.body[0];
        if (statement?.type !== 'ReturnStatement' || statement.argument?.type !== 'Literal' ||
            statement.argument.value !== 1) continue;
        edit(fn, 'function f(x){return 1}');
      }
    },
    verify: ({ after, matches }) => matches.length === 1 && after.code.includes('function f(x){'),
  },
  {
    id: 'voice-mode', anchors: [],
    // present:true rides along with a real match, so the folded no-op must
    // keep the old runner out of its stale branch (a match-less present id
    // would fail the run even though the composition verified).
    scan({ nodes, edit, result }) {
      for (const statement of nodes('ReturnStatement')) {
        const argument = statement.argument;
        if (argument?.type === 'Literal' && argument.value === 1) {
          result.present = true;
          edit(argument, '2');
        }
      }
    },
    verify: ({ after }) => after.code.includes('return 2') && !after.code.includes('return 1'),
  },
];
`;
  const failureFixture = `
export const modules = [
  {
    id: 'ultraplan', anchors: [],
    scan({ nodes, edit }) {
      for (const fn of nodes('FunctionDeclaration')) {
        if (fn.id?.name === 'f' && !fn.params.length) edit(fn, 'function f(){}');
      }
    },
    verify: ({ after }) => after.code.includes('function f(){}'),
  },
  {
    id: 'voice-mode', anchors: [],
    scan({ nodes, edit }) {
      for (const statement of nodes('ReturnStatement')) {
        const argument = statement.argument;
        if (argument?.type === 'Literal' && argument.value === 1) edit(argument, '2');
      }
    },
    verify: ({ after }) => after.code.includes('return 2'),
  },
];
`;
  const prepare = (label, fixture) => {
    const dir = join(root, label);
    mkdirSync(dir);
    for (const name of ['patch.mjs', 'ast-patches.mjs', 'acorn.mjs']) {
      copyFileSync(new URL(`./${name}`, import.meta.url), join(dir, name));
    }
    cpSync(new URL('./ast', import.meta.url), join(dir, 'ast'), { recursive: true });
    writeFileSync(join(dir, 'ast/combination-fixture.mjs'), fixture);
    const source = readFileSync(join(dir, 'ast-patches.mjs'), 'utf8');
    assert.ok(source.includes('defineModules([userTypeAnt]'), 'fixture wiring depends on the default MODULES line');
    writeFileSync(join(dir, 'ast-patches.mjs'),
      `import * as combinationFixture from './ast/combination-fixture.mjs';\n` +
      source.replace('defineModules([userTypeAnt]', 'defineModules([userTypeAnt, ...combinationFixture.modules]'));
    return dir;
  };
  try {
    for (const graph of [false, true]) {
      const dir = prepare(graph ? 'apply-graph' : 'apply-legacy', successFixture);
      const entry = join(dir, 'cli.original.cjs');
      if (graph) { mkdirSync(join(dir, 'bunfs')); writeFileSync(entry, '// entry'); }
      const target = graph ? join(dir, 'bunfs/commands.js') : entry;
      const run = (...args) => spawnSync(process.execPath, [join(dir, 'patch.mjs'), ...args], { encoding: 'utf8' });
      const source = 'function f(){return 1}var unrelated=1;';
      const patched = 'function f(x){return 2}var unrelated=1;';
      writeFileSync(target, source);

      const dry = run('--dry-run');
      assert.equal(dry.status, 0, dry.stderr + dry.stdout);
      // A cross-id overlap folds into one whole-file replacement credited to
      // the first participant. The second participant's matches survive as
      // no-ops, so it reports "no change needed" instead of going stale, and
      // the file still receives both edits.
      assert.match(dry.stdout, /Ultraplan enable \(1 replacement in 1 file\)/);
      assert.match(dry.stdout, /Voice Mode enable \(bypass GrowthBook kill\) \(no change needed\)/);
      assert.equal(readFileSync(target, 'utf8'), source, 'dry-run must not write');

      const verified = run('--verify');
      assert.equal(verified.status, 0, verified.stderr + verified.stdout);
      assert.match(verified.stdout, /Ultraplan enable — 1 match\(es\), not yet applied/);
      assert.match(verified.stdout,
        /Voice Mode enable \(bypass GrowthBook kill\) — 1 match\(es\), not yet applied/);
      assert.equal(readFileSync(target, 'utf8'), source, 'verify must not write');

      assert.equal(run('--capture-clean-source').status, 0);
      const first = run();
      assert.equal(first.status, 0, first.stderr + first.stdout);
      assert.equal(readFileSync(target, 'utf8'), patched);
      const second = run();
      assert.equal(second.status, 0, second.stderr + second.stdout);
      // A normal run starts from the clean source backup, so a settled file
      // reproduces the same composition and the same status lines.
      assert.equal(second.stdout.match(/Result:.*/)[0], first.stdout.match(/Result:.*/)[0]);
      assert.equal(readFileSync(target, 'utf8'), patched, 'repeated application is stable');
      assert.equal(run('--revert').status, 0);
      assert.equal(readFileSync(target, 'utf8'), source);
    }

    // Multi-file graph run: a folded file and a single-participant file are
    // patched in the same run, and --revert restores both.
    {
      const dir = prepare('apply-graph-multi', successFixture);
      mkdirSync(join(dir, 'bunfs'));
      writeFileSync(join(dir, 'cli.original.cjs'), '// entry');
      const folded = join(dir, 'bunfs/commands.js');
      const single = join(dir, 'bunfs/other.js');
      const foldedSource = 'function f(){return 1}';
      const singleSource = 'function g(){return 1}';
      writeFileSync(folded, foldedSource);
      writeFileSync(single, singleSource);
      const run = (...args) => spawnSync(process.execPath, [join(dir, 'patch.mjs'), ...args], { encoding: 'utf8' });
      assert.equal(run('--capture-clean-source').status, 0);
      const applied = run();
      assert.equal(applied.status, 0, applied.stderr + applied.stdout);
      assert.equal(readFileSync(folded, 'utf8'), 'function f(x){return 2}',
        'the folded file gets the composed text');
      assert.equal(readFileSync(single, 'utf8'), 'function g(){return 2}',
        'a single-participant file keeps the per-id edit');
      assert.equal(run('--revert').status, 0);
      assert.equal(readFileSync(folded, 'utf8'), foldedSource);
      assert.equal(readFileSync(single, 'utf8'), singleSource);
    }

    // A refused combination aborts every write mode, --tolerate-stale included,
    // and no other file in the run is written either.
    for (const graph of [false, true]) {
      const dir = prepare(graph ? 'refuse-graph' : 'refuse-legacy', failureFixture);
      const entry = join(dir, 'cli.original.cjs');
      if (graph) { mkdirSync(join(dir, 'bunfs')); writeFileSync(entry, '// entry'); }
      const target = graph ? join(dir, 'bunfs/commands.js') : entry;
      const run = (...args) => spawnSync(process.execPath, [join(dir, 'patch.mjs'), ...args], { encoding: 'utf8' });
      const source = 'function f(){return 1}';
      writeFileSync(target, source);
      const clean = graph ? join(dir, 'bunfs/clean.js') : null;
      const cleanSource = 'function g(){return 1}';
      if (clean) writeFileSync(clean, cleanSource);
      for (const args of [[], ['--dry-run'], ['--verify'], ['--tolerate-stale']]) {
        const failure = run(...args);
        assert.equal(failure.status, 1, failure.stderr + failure.stdout);
        assert.match(failure.stderr, /AST scan failed: AST combination conflict: lost or unverified target \(voice-mode\)/);
        assert.equal(readFileSync(target, 'utf8'), source, 'a refused combination writes nothing');
        if (clean) assert.equal(readFileSync(clean, 'utf8'), cleanSource,
          'a refused combination leaves unrelated files untouched');
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('[ast-patches.test] semantic ranges, gates, drift, backups and failure safety passed');
