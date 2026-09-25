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

  // The provider check moved into a no-argument helper in Claude 2.1.280.
  // Both forms must keep the upstream restriction when the feature is off.
  for (const graph of [false, true]) {
    if (graph) mkdirSync(join(testDir, 'bunfs'));
    else rmSync(join(testDir, 'bunfs'), { recursive: true, force: true });
    for (const [label, condition] of [
      ['inline provider', 'provider!=="firstParty"&&!isAws(provider)&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku"))'],
      ['provider helper', 'isThirdParty()&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku"))'],
    ]) {
      const source = `function isThirdParty(){return provider!=="firstParty"&&!isAws(provider)}function isAws(value){return value==="anthropicAws"}function supports(model){if(${condition})return!1;return!0}`;
      const target = join(testDir, graph ? 'bunfs/auto-mode.js' : 'cli.original.cjs');
      if (graph) writeFileSync(join(testDir, 'cli.original.cjs'), '// entry');
      writeFileSync(target, source);
      const output = execFileSync(process.execPath, [join(testDir, 'patch.mjs')], { encoding: 'utf8' });
      assert.match(output, /Auto-mode unlock for third-party API \(inline gate\) \(1 replacement in 1 file\)/, label);
      const patched = readFileSync(target, 'utf8');
      for (const toggle of [false, true]) {
        for (const provider of ['firstParty', 'anthropicAws', 'proxy']) {
          const context = { provider, __clawgodPatches: { 'auto-mode-inline-gate': toggle } };
          const result = runInNewContext(`${patched};supports("claude-sonnet-4-6")`, context);
          assert.equal(result, toggle || provider !== 'proxy', `${label}: ${provider}, toggle ${toggle}`);
        }
      }
    }
  }
} finally {
  rmSync(testDir, { recursive: true, force: true });
}
console.log('[patch.test] ultraplan bundle/graph compatibility and toggle semantics ok');
console.log('[patch.test] auto-mode provider gate compatibility and toggle semantics ok');
