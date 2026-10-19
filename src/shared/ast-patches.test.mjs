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
  ['remote-settings-off', 'wiggly-dove'].includes(id) ? 0 : 1, id);
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
console.log('[ast-patches.test] semantic ranges, gates, drift, backups and failure safety passed');
