// Patch regression tests, including classifierTimeoutFloor — the parser behind the
// classifier-timeout patch (see runtime-helpers.cjs). Gating
// (globalThis.__clawgodPatches?.["classifier-timeout"]) and the
// CLAWGOD_CLASSIFIER_TIMEOUT_MS read live in the injected patch code; the
// helper only parses/validates the raw value and returns null on failure.
// This test pins both the parser and the exact gate composition the patch
// emits.
//
// Coverage (per PR review): legal values, illegal values (Infinity, overflow,
// non-numeric, blank, unset), and the classifier-tuning-gate-off case.
// Run: node src/shared/patch.test.mjs  (wired into CI build-sources)

import { classifierTimeoutFloor as floor } from './runtime-helpers.cjs';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

// legal values → parsed as the floor (injected Math.max applies it)
assert.equal(floor('200000'), 200000);
assert.equal(floor('5000'), 5000);
assert.equal(floor('-100000'), -100000);
// "0" is a legitimate override, not a failure
assert.equal(floor('0'), 0);
// parse failure → null (caller keeps the original formula)
assert.equal(floor('Infinity'), null);
assert.equal(floor('1e309'), null);
assert.equal(floor('abc'), null);
assert.equal(floor(''), null);
assert.equal(floor('   '), null);
assert.equal(floor(undefined), null);

// Gate composition as the patch emits it: gate ? floor(env) : null, then
// _ct===null ? formula : Math.max(formula, _ct). Null (gate off or parse
// failure) keeps the original formula; a real number — a legitimate "0"
// included — is applied as a floor. No 0 sentinel.
const patchRes = (env, gateOn, formula) => {
  const _ct = gateOn ? floor(env) : null;
  return _ct === null ? formula : Math.max(formula, _ct);
};
// gate on, legal → floor applied (defeats the formula/cap when larger)
assert.equal(patchRes('200000', true, 100), 200000);
// gate on, floor below the formula → formula kept
assert.equal(patchRes('5000', true, 80000), 80000);
// gate on, legal "0" → neutral floor, formula kept (0 is not a failure)
assert.equal(patchRes('0', true, 80000), 80000);
assert.equal(patchRes('0', true, 0), 0);
// gate off → env ignored even when legal
assert.equal(patchRes('200000', false, 100), 100);
// gate on, parse failure (null) → original formula kept
assert.equal(patchRes('Infinity', true, 80000), 80000);
assert.equal(patchRes('1e309', true, 80000), 80000);
assert.equal(patchRes('', true, 80000), 80000);
assert.equal(patchRes(undefined, true, 80000), 80000);

console.log('[patch.test] classifierTimeoutFloor semantics ok');

// Exercise the real patcher against legacy bundles and the 2.1.268 chunk
// layout (issues #175–177). Keep metadata and neighboring commands intact,
// and evaluate the emitted gate with the feature both enabled and disabled.
const ultraplanFixtures = [
  { label: 'legacy literal', description: 'description:`Draft a plan`', original: '!1' },
  { label: 'getter and flag helper', description: 'get description(){return`Draft a plan (${estimate()})`}', original: '$flag()' },
  { label: '2.1.268 availability', description: 'get description(){return`Draft a plan (${estimate()})`}', original: '$flag()', metadata: 'availability:["claude-ai"],' },
];
const testDir = mkdtempSync(join(tmpdir(), 'clawgod-patch-test-'));
try {
  copyFileSync(new URL('./patch.mjs', import.meta.url), join(testDir, 'patch.mjs'));
  for (const graph of [false, true]) {
    if (graph) mkdirSync(join(testDir, 'bunfs'));
    for (const fixture of ultraplanFixtures) {
      const source = `var command={type:"local-jsx",name:"ultraplan",${fixture.description},argumentHint:"<prompt>",${fixture.metadata || ''}isEnabled:()=>${fixture.original},policyGate:policy,load:()=>load()};var neighbor={name:"other",argumentHint:"<prompt>",isEnabled:()=>!1};`;
      const target = join(testDir, graph ? 'bunfs/commands.js' : 'cli.original.cjs');
      if (graph) writeFileSync(join(testDir, 'cli.original.cjs'), '// entry');
      writeFileSync(target, source);
      const output = execFileSync(process.execPath, [join(testDir, 'patch.mjs')], { encoding: 'utf8' });
      assert.match(output, /Ultraplan enable \(1 replacement in 1 file\)/, fixture.label);
      const patched = readFileSync(target, 'utf8');
      const enabled = `isEnabled:()=>${fixture.original}`;
      assert.equal(patched, source.replace(enabled, `isEnabled:()=>(globalThis.__clawgodPatches?.["ultraplan"]!==!1?!0:${fixture.original})`));
      for (const toggle of [undefined, true, false]) {
        for (const upstream of [false, true]) {
          let calls = 0;
          const context = {
            $flag: () => { calls++; return upstream; },
            estimate: () => 'a few minutes', policy: () => false, load: () => 'loaded',
            ...(toggle === undefined ? {} : { __clawgodPatches: { ultraplan: toggle } }),
          };
          const result = runInNewContext(`${patched};[command.isEnabled(),neighbor.isEnabled(),command.description,command.policyGate(),command.load()]`, context);
          const originalValue = fixture.original === '!1' ? false : upstream;
          assert.equal(result[0], toggle === false ? originalValue : true, fixture.label);
          assert.equal(result[1], false);
          assert.match(result[2], /^Draft a plan/);
          assert.equal(result[3], false);
          assert.equal(result[4], 'loaded');
          assert.equal(calls, toggle === false && fixture.original !== '!1' ? 1 : 0);
        }
      }
    }
    // An unsupported shape must stay visible as a failure, even if a nearby
    // command happens to contain the old argumentHint/isEnabled sequence.
    for (const body of [
      'description:"Future gate",argumentHint:"<prompt>",newMetadata:!0,isEnabled:()=>$flag()',
      'description:"Cloud command stub"',
    ]) {
      const source = `var command={name:"ultraplan",${body}};var neighbor={name:"other",argumentHint:"<prompt>",isEnabled:()=>!1};`;
      const target = join(testDir, graph ? 'bunfs/commands.js' : 'cli.original.cjs');
      writeFileSync(target, source);
      const output = execFileSync(process.execPath, [join(testDir, 'patch.mjs')], { encoding: 'utf8' });
      assert.match(output, /Ultraplan enable — regex stale/);
      assert.equal(readFileSync(target, 'utf8'), source);
    }
  }
} finally {
  rmSync(testDir, { recursive: true, force: true });
}
console.log('[patch.test] ultraplan bundle/graph compatibility and toggle semantics ok');
// ─── dangerous-rm-bypass: bypass-site predicate semantics ────────────
//
// The patch wraps the bypass-mode S1e call site:
//   B = F && v?.behavior==="ask" ? xb(v.decisionReason,
//        (S1e) => S1e.circuitBreaker !== "dangerousRemoval" ||
//                 !(gate("dangerous-rm-bypass"))) : void 0
// with the shared breaker table left untouched (upstream
// {dangerousRemoval:{bypassImmune:!0,classifierRouted:!0}} — v1 of PR #172
// flipped the table itself, which also flipped the mode-independent
// pipe-aggregation multi-cd branch and could allow a degraded multi-cd
// ask under a whole-tool Bash allow rule in default mode; see PR review).
//
// These tests re-implement iao's decision skeleton + the verbatim Pso
// multi-cd aggregation from the 2.1.260 bundle and pin:
//   - default mode: dangerousRemoval ask survives with/without allow
//     rules, gate on or off (upstream behavior)
//   - bypass mode: gate on -> allow, gate off -> ask
//   - pipe multi-cd aggregation preserves the dangerousRemoval safetyCheck
//     ask regardless of the gate (shared table untouched)
// Run: node src/shared/patch.test.mjs  (wired into CI build-sources)

// upstream breaker table (the shape the patcher must NOT modify)
const table = {
  dangerousRemoval: { bypassImmune: true, classifierRouted: true },
  backgroundOperator: { bypassImmune: false, classifierRouted: true },
  suspiciousWindowsPath: { bypassImmune: false, classifierRouted: true },
  isolatePeerMachines: { bypassImmune: true, classifierRouted: false },
  restrictedMode: { bypassImmune: true, classifierRouted: false },
  outsideReadsBlocked: { bypassImmune: true, classifierRouted: false },
};
const isBypassImmune = (e) =>
  e.circuitBreaker !== undefined && table[e.circuitBreaker]?.bypassImmune === true;
// real xb(): recursive safetyCheck search with optional predicate
const xb = (e, n = () => true) => {
  if (!e) return undefined;
  if (e.type === 'safetyCheck') return n(e) ? e : undefined;
  if (e.type === 'subcommandResults')
    for (const r of e.reasons.values()) {
      const o = xb(r.decisionReason, n);
      if (o) return o;
    }
  return undefined;
};

const dangerousAsk = {
  behavior: 'ask',
  decisionReason: {
    type: 'safetyCheck',
    reason: 'Dangerous rm operation detected',
    classifierApprovable: false,
    circuitBreaker: 'dangerousRemoval',
  },
};
const multiCdAsk = {
  behavior: 'ask',
  decisionReason: {
    type: 'other',
    reason: 'Multiple directory changes in one command require approval for clarity',
    bashMissKind: 'multi-cd',
  },
};

// iao decision skeleton, gate-on form (patched expression verbatim)
const decide = (v, mode, gateOn, wholeToolAllowRule) => {
  globalThis.__clawgodPatches = { 'dangerous-rm-bypass': gateOn };
  const N = mode;
  const F = N === 'bypassPermissions' || N === 'plan';
  const B = F && v?.behavior === 'ask'
    ? xb(v.decisionReason, (S1e) =>
        S1e.circuitBreaker !== 'dangerousRemoval' ||
        !(globalThis.__clawgodPatches?.['dangerous-rm-bypass'] !== false))
    : undefined;
  if (v?.behavior === 'ask' &&
      (B || !F && (xb(v.decisionReason) || v.decisionReason?.type === 'sandboxOverride')))
    return 'ask';
  if (F) return 'allow';
  if (wholeToolAllowRule) return 'allow';
  return 'ask';
};
// upstream (unpatched) decision for the same skeleton
const upstreamDecide = (v, mode, wholeToolAllowRule) => {
  const F = mode === 'bypassPermissions' || mode === 'plan';
  const B = F && v?.behavior === 'ask' ? xb(v.decisionReason, isBypassImmune) : undefined;
  if (v?.behavior === 'ask' &&
      (B || !F && (xb(v.decisionReason) || v.decisionReason?.type === 'sandboxOverride')))
    return 'ask';
  if (F) return 'allow';
  if (wholeToolAllowRule) return 'allow';
  return 'ask';
};

// default mode: unchanged in every combination (P1 regression guard)
assert.equal(upstreamDecide(dangerousAsk, 'default', false),
             decide(dangerousAsk, 'default', true, false));
assert.equal(upstreamDecide(dangerousAsk, 'default', false), 'ask');
assert.equal(decide(dangerousAsk, 'default', true, false), 'ask');
// P1 exact case: default + whole-tool Bash allow rule must still ask
assert.equal(decide(dangerousAsk, 'default', true, true), 'ask');
assert.equal(decide(dangerousAsk, 'default', false, true), 'ask');
// gate off in bypass mode restores upstream (ask)
assert.equal(decide(dangerousAsk, 'bypassPermissions', false, false), 'ask');
// bypass mode + gate on -> allow (the feature)
assert.equal(decide(dangerousAsk, 'bypassPermissions', true, false), 'allow');
// non-dangerousRemoval breakers keep their bypass immunity
const restrictedAsk = { behavior: 'ask', decisionReason: { type: 'safetyCheck', reason: 'restricted', circuitBreaker: 'restrictedMode' } };
assert.equal(decide(restrictedAsk, 'bypassPermissions', true, false), 'ask');
// plain multi-cd ask: bypass allows it (was never bypass-immune), default asks
assert.equal(decide(multiCdAsk, 'bypassPermissions', true, false), 'allow');
assert.equal(decide(multiCdAsk, 'default', true, true), 'allow');

// pipe-aggregation multi-cd branch (verbatim Pso shape) uses the shared
// table only — with the gate ON it must still preserve the
// dangerousRemoval safetyCheck ask instead of degrading to multi-cd
const multiCdAggregate = (E) => {
  for (const [, z] of E)
    if (z.behavior === 'ask' && xb(z.decisionReason, isBypassImmune)) return z;
  return multiCdAsk;
};
const E = new Map([
  ['cd /tmp/a', { behavior: 'allow' }],
  ['cd /tmp/b', { behavior: 'allow' }],
  ['rm sub/*', dangerousAsk],
]);
const aggregated = multiCdAggregate(E);
assert.equal(aggregated.decisionReason.type, 'safetyCheck');
assert.equal(aggregated.decisionReason.circuitBreaker, 'dangerousRemoval');
// and that preserved safetyCheck ask then survives a whole-tool allow rule
// in default mode even with the gate on
assert.equal(decide(aggregated, 'default', true, true), 'ask');
// while in bypass mode with the gate on it is allowed (feature goal)
assert.equal(decide(aggregated, 'bypassPermissions', true, false), 'allow');

console.log('[patch.test] dangerous-rm-bypass bypass-site semantics ok');
