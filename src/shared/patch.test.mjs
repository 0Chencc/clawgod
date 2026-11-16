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
import { execFileSync, spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createServer, request } from 'node:http';
import { normalizePatches, expandPatches, selectVariants, validateRegistry } from './patch-variants.mjs';

// Logical patch model: a flat registry entry keeps its historical id as both
// the runtime gate key and the AST matcher key; a grouped entry expands to one
// work item per variant. Version ranges select at most one variant per logical
// patch; gaps are allowed, overlaps are rejected.
{
  const flat = normalizePatches([
    { id: 'flat', name: 'Flat patch', toggleable: true, pattern: /a/g, replacer: () => 'b' },
    { id: 'core', name: 'Core patch', ast: true },
  ]);
  assert.deepEqual(flat.map(p => [p.id, p.toggleable, p.variants.length]), [
    ['flat', true, 1],
    ['core', false, 1],
  ]);
  assert.deepEqual(expandPatches(flat).map(i => [i.id, i.name]), [
    ['flat', 'Flat patch'],
    ['core', 'Core patch'],
  ]);
  assert.deepEqual(expandPatches(selectVariants(flat, 'unknown')).map(i => i.id), ['flat', 'core']);

  const gatedFlat = normalizePatches([
    { id: 'gated', name: 'Gated patch', toggleable: true, since: '2.1.212', pattern: /a/g, replacer: () => 'b' },
  ]);
  assert.deepEqual(selectVariants(gatedFlat, '2.1.211'), []);
  assert.deepEqual(selectVariants(gatedFlat, '2.1.212').map(p => p.id), ['gated']);
  assert.deepEqual(selectVariants(gatedFlat, 'unknown'), []);

  const grouped = [{
    id: 'grouped',
    name: 'Grouped patch',
    toggleable: true,
    variants: [
      { until: '2.1.211', pattern: /x/g, replacer: () => 'y' },
      { since: '2.1.212', ast: true },
    ],
  }];
  const normalized = normalizePatches(grouped);
  assert.deepEqual(expandPatches(normalized).map(i => [i.id, i.name]), [
    ['grouped', 'Grouped patch'],
    ['grouped', 'Grouped patch'],
  ]);
  assert.equal(selectVariants(normalized, '2.1.211')[0].variants[0].pattern.source, 'x');
  assert.equal(selectVariants(normalized, '2.1.212')[0].variants[0].ast, true);
  assert.deepEqual(selectVariants(normalized, 'unknown'), []);

  const gap = [{
    id: 'gap',
    name: 'Gap patch',
    toggleable: true,
    variants: [
      { until: '2.1.211', pattern: /x/g, replacer: () => 'y' },
      { since: '2.1.215', ast: true },
    ],
  }];
  assert.deepEqual(validateRegistry({
    patches: gap,
    features: { gap: { desc: 'test', patchIds: ['gap'] } },
    astPatchIds: ['gap'],
  }), []);
  assert.deepEqual(selectVariants(normalizePatches(gap), '2.1.213'), []);

  const features = { grouped: { desc: 'test', patchIds: ['grouped'] } };

  const overlap = validateRegistry({
    patches: [{
      id: 'overlap',
      name: 'Overlap patch',
      toggleable: true,
      variants: [
        { until: '2.1.211', pattern: /x/g, replacer: () => 'y' },
        { since: '2.1.211', ast: true },
      ],
    }],
    features: { overlap: { desc: 'test', patchIds: ['overlap'] } },
    astPatchIds: ['overlap'],
  });
  assert(overlap.some(e => /overlapping variants/.test(e)), overlap.join('; '));

  // A bounded variant overlaps an unbounded one.
  const mixedBounds = validateRegistry({
    patches: [{
      id: 'mixed-bounds',
      name: 'Mixed bounds',
      toggleable: true,
      variants: [
        { until: '2.1.211', pattern: /x/g, replacer: () => 'y' },
        { ast: true },
      ],
    }],
    features: { 'mixed-bounds': { desc: 'test', patchIds: ['mixed-bounds'] } },
    astPatchIds: ['mixed-bounds'],
  });
  assert(mixedBounds.some(e => /overlapping variants/.test(e)), mixedBounds.join('; '));

  const badRange = validateRegistry({
    patches: [{
      id: 'bad-range',
      name: 'Bad range',
      toggleable: true,
      variants: [
        { since: '2.1.x', pattern: /x/g, replacer: () => 'y' },
        { since: '2.1.220', until: '2.1.210', ast: true },
      ],
    }],
    features: { 'bad-range': { desc: 'test', patchIds: ['bad-range'] } },
    astPatchIds: ['bad-range'],
  });
  assert(badRange.some(e => /invalid since/.test(e)), badRange.join('; '));
  assert(badRange.some(e => /since after until/.test(e)), badRange.join('; '));

  const errors = validateRegistry({
    patches: [{
      id: 'grouped',
      name: 'Grouped patch',
      toggleable: true,
      pattern: /oops/g,
      variants: [
        { until: '2.1.211', ast: true },
        { since: '2.1.212', name: 'nested', pattern: /x/g, replacer: () => 'y' },
      ],
    }],
    features,
    astPatchIds: [],
  });
  for (const expected of [
    /has field 'pattern' outside variants/,
    /has logical field 'name'/,
    /has no matcher in AST_PATCH_IDS/,
  ]) {
    assert(errors.some(e => expected.test(e)), `missing error ${expected}: ${errors.join('; ')}`);
  }

  const empty = validateRegistry({
    patches: [{ id: 'empty', name: 'Empty patch', toggleable: true, variants: [] }],
    features: { empty: { desc: 'test', patchIds: ['empty'] } },
    astPatchIds: [],
  });
  assert(empty.some(e => /has no variants/.test(e)), empty.join('; '));

  // Flat entries are one implicit variant and get the same behavior checks.
  const flatShape = validateRegistry({
    patches: [
      { id: 'flat-ast', name: 'Flat AST', ast: true },
      { id: 'flat-no-pattern', name: 'Flat no pattern', replacer: () => 'x' },
      { id: 'flat-no-replacer', name: 'Flat no replacer', pattern: /x/g },
      { id: 'flat-bad-variants', name: 'Flat bad variants', variants: 'oops' },
      { id: 'flat-bad-since', name: 'Flat bad since', since: '2.1.x', pattern: /x/g, replacer: () => 'x' },
    ],
    features: {},
    astPatchIds: [],
  });
  for (const expected of [
    /AST variant of 'flat-ast' has no matcher in AST_PATCH_IDS/,
    /patch 'flat-no-pattern' has no pattern/,
    /patch 'flat-no-replacer' has no replacer/,
    /patch 'flat-bad-variants' has non-array variants/,
    /variant of 'flat-bad-since' has invalid since/,
  ]) {
    assert(flatShape.some(e => expected.test(e)), `missing error ${expected}: ${flatShape.join('; ')}`);
  }

  // Missing segments compare as zero, so '2.1' and '2.1.0' are equivalent in
  // both directions.
  const loose = normalizePatches([
    { id: 'loose', name: 'Loose', since: '2.1', pattern: /x/g, replacer: () => 'x' },
    { id: 'padded', name: 'Padded', since: '2.1.0', pattern: /x/g, replacer: () => 'x' },
  ]);
  assert.deepEqual(selectVariants(loose, '2.1').map(p => p.id), ['loose', 'padded']);
  assert.deepEqual(selectVariants(loose, '2.1.0').map(p => p.id), ['loose', 'padded']);
  assert.deepEqual(selectVariants(loose, '2.1.2').map(p => p.id), ['loose', 'padded']);

  const three = [{
    id: 'three',
    name: 'Three variants',
    toggleable: true,
    variants: [
      { until: '2.1.100', pattern: /x/g, replacer: () => 'y' },
      { since: '2.1.101', until: '2.1.200', ast: true },
      { since: '2.1.201', pattern: /x/g, replacer: () => 'y' },
    ],
  }];
  assert.deepEqual(validateRegistry({
    patches: three,
    features: { three: { desc: 'test', patchIds: ['three'] } },
    astPatchIds: ['three'],
  }), []);
  assert.equal(selectVariants(normalizePatches(three), '2.1.150')[0].variants[0].ast, true);
}

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
  for (const name of ['patch.mjs', 'patch-variants.mjs', 'ast-patches.mjs', 'acorn.mjs']) {
    copyFileSync(new URL(`./${name}`, import.meta.url), join(testDir, name));
  }
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
      assert.equal(patched, source.replace(enabled, `isEnabled:()=>(globalThis.__clawgodPatches?.["ultraplan"]!==!1?!0:(${fixture.original}))`));
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
      'description:"Future gate",argumentHint:"<prompt>",newMetadata:!0,isEnabled:futureGate',
      'description:"Cloud command stub"',
    ]) {
      const source = `var command={name:"ultraplan",${body}};var neighbor={name:"other",argumentHint:"<prompt>",isEnabled:()=>!1};`;
      const target = join(testDir, graph ? 'bunfs/commands.js' : 'cli.original.cjs');
      writeFileSync(target, source);
      const result = spawnSync(process.execPath, [join(testDir, 'patch.mjs')], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Ultraplan enable — AST matcher stale/);
      assert.equal(readFileSync(target, 'utf8'), source);
    }
  }

  // --tolerate-stale (#224): a single drifted regex must not be able to abort
  // the whole install once the caller opts in. The stale patch keeps upstream
  // behavior, every other patch still lands, and the default run is unchanged
  // — no flag, no write, exit 1.
  for (const graph of [false, true]) {
    rmSync(join(testDir, 'bunfs'), { recursive: true, force: true });
    if (graph) mkdirSync(join(testDir, 'bunfs'));
    const target = join(testDir, graph ? 'bunfs/mixed.js' : 'cli.original.cjs');
    if (graph) writeFileSync(join(testDir, 'cli.original.cjs'), '// entry');
    const source =
      'var command={name:"ultraplan",description:"Cloud command stub"};' +
      'function isThirdParty(){return provider!=="firstParty"&&!isAws(provider)}' +
      'function isAws(value){return value==="anthropicAws"}' +
      'function supports(model){if(isThirdParty()&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku")))return!1;return!0}';
    const layout = graph ? 'graph' : 'legacy';

    writeFileSync(target, source);
    const strict = spawnSync(process.execPath, [join(testDir, 'patch.mjs')], { encoding: 'utf8' });
    assert.equal(strict.status, 1, `${layout}: stale patch still aborts by default`);
    assert.match(strict.stdout, /Ultraplan enable — AST matcher stale/);
    assert.equal(readFileSync(target, 'utf8'), source, `${layout}: default run writes nothing`);

    const lenient = spawnSync(process.execPath, [join(testDir, 'patch.mjs'), '--tolerate-stale'], { encoding: 'utf8' });
    assert.equal(lenient.status, 0, `${layout}: --tolerate-stale completes the install`);
    assert.match(lenient.stdout, /\d+ applied, \d+ skipped, 0 failed, 1 tolerated/);
    assert.match(lenient.stdout, /Ultraplan enable — AST matcher stale.*\(tolerated\)/);
    assert.match(lenient.stdout, /Tolerated \(skipped, upstream behavior kept\): Ultraplan enable/);

    const patched = readFileSync(target, 'utf8');
    assert.match(patched, /name:"ultraplan",description:"Cloud command stub"/, `${layout}: stale patch kept upstream behavior`);
    assert.match(patched, /globalThis\.__clawgodPatches\?\.\["auto-mode-inline-gate"\]/, `${layout}: remaining patches still applied`);
  }

  // The provider check moved into a no-argument helper in Claude 2.1.280.
  // Both forms must keep the upstream restriction when the feature is off.
  for (const graph of [false, true]) {
    rmSync(join(testDir, 'bunfs'), { recursive: true, force: true });
    if (graph) mkdirSync(join(testDir, 'bunfs'));
    for (const [label, condition, setup = '', tail = 'return!0'] of [
      ['legacy inline provider', 'provider!=="firstParty"&&provider!=="anthropicAws"'],
      ['inline provider', 'provider!=="firstParty"&&!isAws(provider)&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku"))'],
      ['provider helper', 'isThirdParty()&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku"))'],
      ['provider helper with haiku exemption (v2.1.293+)', 'isThirdParty()&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku")&&model!=="claude-haiku-5-5")'],
      ['provider helper with future exclusions', 'isThirdParty()&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku")&&model!=="claude-haiku-5-5"&&!isExcluded(model))'],
      ['cached provider with split Haiku return (v2.1.323+)', 'cached&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6")',
        'const cached=isThirdParty();', 'return !(cached&&model.includes("haiku")&&model!=="claude-haiku-5-5")'],
    ]) {
      const source = `function isThirdParty(){return provider!=="firstParty"&&!isAws(provider)}function isAws(value){return value==="anthropicAws"}function supports(model){${setup}if(${condition})return!1;${tail}}`;
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

// Classifier model override retirement: CLAWGOD_CLASSIFIER_MODEL applies
// through 2.1.301 only. From 2.1.302 the official
// CLAUDE_CODE_AUTO_MODE_MODEL path owns resolution and must stay untouched.
{
  const testDir = mkdtempSync(join(tmpdir(), 'clawgod-classifier-model-test-'));
  // Same resolution shape the legacy regex targets in both versions; 2.1.302
  // adds the official env branch inside the body, which the patch must not
  // shadow.
  const classifierSource = (version, official) => `// Version: ${version}
function at(){return null}
function Ih(){return {model:"main-model",modelByMainModel:{}}}
function usr(){return null}
function avt(){return null}
function resolveClassifierModel(){let e=at(),n=Ih(),r=usr(n?.modelByMainModel,{vet:x=>x})??avt(n?.model,"model");if(r)return{value:r,src:"gb"};${official ? 'if(process.env.CLAUDE_CODE_AUTO_MODE_MODEL)return{value:process.env.CLAUDE_CODE_AUTO_MODE_MODEL,src:"env"};' : ''}return{value:"default-model",src:"default"}}`;
  const resolveModel = (source, env, toggle) => {
    const result = runInNewContext(`${source};resolveClassifierModel()`, {
      __clawgodPatches: { 'classifier-model': toggle },
      process: { env },
    });
    return { value: result.value, src: result.src };
  };
  try {
    for (const name of ['patch.mjs', 'patch-variants.mjs', 'ast-patches.mjs', 'acorn.mjs']) {
      copyFileSync(new URL(`./${name}`, import.meta.url), join(testDir, name));
    }
    const target = join(testDir, 'cli.original.cjs');

    // 2.1.301: the legacy override still wins when its gate is on.
    writeFileSync(target, classifierSource('2.1.301', false));
    const legacyOutput = execFileSync(process.execPath, [join(testDir, 'patch.mjs')], { encoding: 'utf8' });
    assert.match(legacyOutput, /Auto-mode classifier model override \(CLAWGOD_CLASSIFIER_MODEL\) \(1 replacement in 1 file\)/);
    const legacyPatched = readFileSync(target, 'utf8');
    assert.match(legacyPatched, /process\.env\.CLAWGOD_CLASSIFIER_MODEL/);
    assert.deepEqual(resolveModel(legacyPatched, { CLAWGOD_CLASSIFIER_MODEL: 'legacy-model' }, true),
      { value: 'legacy-model', src: 'default' });
    assert.deepEqual(resolveModel(legacyPatched, { CLAWGOD_CLASSIFIER_MODEL: 'legacy-model' }, false),
      { value: 'default-model', src: 'default' });

    // 2.1.302: the retired patch leaves the bundle byte-identical; the
    // official env override still resolves.
    const official = classifierSource('2.1.302', true);
    writeFileSync(target, official);
    const officialOutput = execFileSync(process.execPath, [join(testDir, 'patch.mjs')], { encoding: 'utf8' });
    assert.doesNotMatch(officialOutput, /Auto-mode classifier model override \(CLAWGOD_CLASSIFIER_MODEL\)/);
    assert.equal(readFileSync(target, 'utf8'), official);
    assert.deepEqual(resolveModel(official,
      { CLAWGOD_CLASSIFIER_MODEL: 'legacy-model', CLAUDE_CODE_AUTO_MODE_MODEL: 'official-model' }, false),
      { value: 'official-model', src: 'env' });
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
  console.log('[patch.test] classifier-model retirement at 2.1.301/2.1.302 ok');
}

// Exercise the collection -> header -> request chain with the flag bindings
// seen in official bundles. No real repository metadata or API credentials.
const privacyDir = mkdtempSync(join(tmpdir(), 'clawgod-wiggly-dove-test-'));
const fixtures = [
  ['2.1.299', 'rw', 'mm'],
  ['2.1.301', 'tw', 'pm'],
  ['2.1.303', 'aw', '_m'],
  ['renamed', '$flag', '$gate'],
];
function privacyFixture(version, flag, check) {
  return `var ${flag}="tengu_wiggly_dove";var other="tengu_other";` +
    'function neighbor(){if(!isFirstParty())return!1;if(!feature(other,!1))return!1;return routeAllowed()}' +
    `function ${check}(){if(!isFirstParty())return!1;if(!feature(${flag},!1))return!1;return routeAllowed()}` +
    `async function collect(){if(!${check}())return;return 'jy="'+readOrigin()+'", ob="${version}"'}` +
    'function header(value){if(value===void 0)return{};return{"x-claude-code-wiggly-dove":value}}' +
    'async function buildRequest(){return{headers:{"x-unrelated":"preserved",...header(await collect())},body:{messages:[{role:"user",content:"hello"}]}}}';
}
try {
  for (const name of ['patch.mjs', 'patch-variants.mjs', 'ast-patches.mjs', 'acorn.mjs']) {
    copyFileSync(new URL(`./${name}`, import.meta.url), join(privacyDir, name));
  }
  let lastPatched;
  for (const graph of [false, true]) {
    if (graph) mkdirSync(join(privacyDir, 'bunfs'));
    const target = join(privacyDir, graph ? 'bunfs/privacy.js' : 'cli.original.cjs');
    if (graph) writeFileSync(join(privacyDir, 'cli.original.cjs'), '// graph entry');
    for (const [version, flag, check] of fixtures) {
      const source = privacyFixture(version, flag, check);
      writeFileSync(target, source);
      const output = execFileSync(process.execPath, [join(privacyDir, 'patch.mjs')], { encoding: 'utf8' });
      assert.match(output, /Block wiggly-dove Git\/environment collection \(1 replacement in 1 file\)/);
      const patched = readFileSync(target, 'utf8');
      assert.equal(patched, source.replace(`function ${check}(){`,
        `function ${check}(){;if(globalThis.__clawgodPatches?.["wiggly-dove"]!==!1)return !1;`));
      execFileSync(process.execPath, [join(privacyDir, 'patch.mjs')]);
      assert.equal(readFileSync(target, 'utf8'), patched, 'repatch without a snapshot is idempotent');
      for (const toggle of [undefined, true, false]) {
        for (const firstParty of [false, true]) {
          for (const upstreamFlag of [false, true]) {
            for (const route of [false, true]) {
              let reads = 0, evaluations = 0;
              const result = await runInNewContext(`${patched};buildRequest()`, {
                ...(toggle === undefined ? {} : { __clawgodPatches: { 'wiggly-dove': toggle } }),
                isFirstParty: () => firstParty,
                feature: (key) => { assert.equal(key, 'tengu_wiggly_dove'); evaluations++; return upstreamFlag; },
                routeAllowed: () => route,
                readOrigin: () => { reads++; return 'git.example.test/team/private-repo'; },
              });
              const expected = toggle === false && firstParty && upstreamFlag && route;
              assert.equal(reads, Number(expected), 'blocked before collecting Git metadata');
              assert.equal(evaluations, Number(toggle === false && firstParty), 'does not consult the rollout when blocked');
              assert.equal('x-claude-code-wiggly-dove' in result.headers, expected);
              assert.equal(result.headers['x-unrelated'], 'preserved');
              assert.equal(JSON.stringify(result.body), '{"messages":[{"role":"user","content":"hello"}]}');
            }
          }
        }
      }
      lastPatched = patched;
    }
    // Older bundles have no collector. An unfamiliar gate in a newer bundle
    // must abort the whole patch transaction, including unrelated changes.
    writeFileSync(target, '// no wiggly-dove in this version');
    execFileSync(process.execPath, [join(privacyDir, 'patch.mjs')]);
    for (const declaration of ['var', 'let', 'const']) {
      const stale = `function userType(){return"external"}${declaration} flag="tengu_wiggly_dove";function changed(){return feature(flag,!1)}`;
      writeFileSync(target, stale);
      const result = spawnSync(process.execPath, [join(privacyDir, 'patch.mjs')], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Block wiggly-dove Git\/environment collection — AST matcher stale/);
      assert.equal(readFileSync(target, 'utf8'), stale, 'failure writes no partially patched source');
    }
  }

  // Capture actual HTTP traffic on loopback. With the upstream rollout on,
  // the private Git marker appears only when the privacy patch is disabled.
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push({ headers: req.headers, body }); res.end('ok'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const toggle of [undefined, true, false]) {
      const outgoing = await runInNewContext(`${lastPatched};buildRequest()`, {
        ...(toggle === undefined ? {} : { __clawgodPatches: { 'wiggly-dove': toggle } }),
        isFirstParty: () => true, feature: () => true, routeAllowed: () => true,
        readOrigin: () => 'git.example.test/team/private-repo',
      });
      await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: server.address().port,
          method: 'POST', headers: outgoing.headers, agent: false }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('loopback capture timed out')));
        req.end(JSON.stringify(outgoing.body));
      });
      const captured = received.at(-1);
      assert.equal('x-claude-code-wiggly-dove' in captured.headers, toggle === false);
      assert.equal(captured.headers['x-unrelated'], 'preserved');
      assert.equal(captured.body, JSON.stringify(outgoing.body));
      if (toggle === false) assert.match(captured.headers['x-claude-code-wiggly-dove'], /git\.example\.test\/team\/private-repo/);
      else assert.ok(!JSON.stringify(captured).includes('git.example.test'));
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
} finally {
  rmSync(privacyDir, { recursive: true, force: true });
}
console.log('[patch.test] wiggly-dove collection, request capture, toggles, idempotence, and stale gates ok');

// tool-result-pairing-recovery patch tests
{
  const testDir = mkdtempSync(join(tmpdir(), 'clawgod-pairing-test-'));
  try {
    for (const name of ['patch.mjs', 'patch-variants.mjs', 'ast-patches.mjs', 'acorn.mjs', 'feature-gates.cjs', 'runtime-helpers.cjs']) {
      copyFileSync(new URL(`./${name}`, import.meta.url), join(testDir, name));
    }
    const source = `
      const kks = "[Tool result missing due to internal error]";
      function permissionErrors(history, ids) {
        void history.length;
        const kks = "Permission denied";
        return ids.map(item => ({
          type: "tool_result", tool_use_id: item,
          content: kks, is_error: true
        }));
      }
      function ensureToolResultPairing(conversationHistory, runtimeOpts) {
        let count = conversationHistory.length;
        let Re = ["call_1", "call_missing"];
        let kks = "[Tool result missing due to internal error]";
        let De=Re.map((conversationHistory)=>({type:"tool_result",tool_use_id:conversationHistory,content:kks,is_error:!0}));
        return De;
      }
    `;
    const target = join(testDir, 'cli.original.cjs');
    writeFileSync(target, source);
    const output = execFileSync(process.execPath, [join(testDir, 'patch.mjs')], { encoding: 'utf8' });
    assert.match(output, /Recover orphaned tool results from history in ensureToolResultPairing \(1 replacement in 1 file\)/);
    const patched = readFileSync(target, 'utf8');
    assert.ok(patched.includes('for(let _m of conversationHistory)'), 'binds dynamically to conversationHistory');
    assert.ok(patched.includes('const kks = "Permission denied"'), 'shadowed non-target error function remains untouched');
    const mockHistory = [
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'BUILD SUCCESSFUL in 1m 21s', is_error: false }
          ]
        }
      }
    ];
    const context = { mockHistory };
    const result = runInNewContext(`${patched};ensureToolResultPairing(mockHistory, {})`, context);
    assert.equal(result.length, 2);
    assert.equal(result[0].tool_use_id, 'call_1');
    assert.equal(result[0].content, 'BUILD SUCCESSFUL in 1m 21s');
    assert.equal(result[0].is_error, false);
    assert.equal(result[1].tool_use_id, 'call_missing');
    assert.equal(result[1].content, '[Tool result missing due to internal error]');
    assert.equal(result[1].is_error, true);
    const denied = runInNewContext(`${patched};permissionErrors(mockHistory,['call_1'])`, {mockHistory});
    assert.equal(denied[0].content, 'Permission denied');
    assert.equal(denied[0].is_error, true);

    // Unsupported callback bodies must fail before writing either source layout.
    for (const graph of [false, true]) {
      const dir = join(testDir, graph ? 'unsupported-graph' : 'unsupported-legacy');
      mkdirSync(dir);
      for (const name of ['patch.mjs', 'patch-variants.mjs', 'ast-patches.mjs', 'acorn.mjs']) {
        copyFileSync(new URL(`./${name}`, import.meta.url), join(dir, name));
      }
      const entry = join(dir, 'cli.original.cjs');
      if (graph) { mkdirSync(join(dir, 'bunfs')); writeFileSync(entry, '// entry'); }
      const target = graph ? join(dir, 'bunfs/pairing.js') : entry;
      const unsupported = `function pairing(history,ids){
        void history.length;
        return ids.map(id=>{
          const err="[Tool result missing due to internal error]";
          return {type:"tool_result",tool_use_id:id,content:err,is_error:true};
        });
      }`;
      writeFileSync(target, unsupported);
      const run = (...args) => spawnSync(process.execPath, [join(dir, 'patch.mjs'), ...args], {encoding:'utf8'});
      const failure = run();
      assert.equal(failure.status, 1, failure.stderr + failure.stdout);
      assert.match(failure.stdout, /Recover orphaned tool results.*AST matcher stale/);
      assert.equal(readFileSync(target, 'utf8'), unsupported);
      const tolerated = run('--tolerate-stale');
      assert.equal(tolerated.status, 0, tolerated.stderr + tolerated.stdout);
      assert.match(tolerated.stdout, /Recover orphaned tool results.*AST matcher stale.*tolerated/);
      assert.equal(readFileSync(target, 'utf8'), unsupported);
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
  console.log('[patch.test] tool-result-pairing-recovery compatibility and recovery semantics ok');
}


// A selection that leaves only AST work items must still flush their edits.
// The normal registry always has regex patches, which trigger the flush; this
// fixture removes them to cover the AST-only path.
{
  const testDir = mkdtempSync(join(tmpdir(), 'clawgod-ast-only-test-'));
  try {
    for (const name of ['patch-variants.mjs', 'ast-patches.mjs', 'acorn.mjs']) {
      copyFileSync(new URL(`./${name}`, import.meta.url), join(testDir, name));
    }
    const patcher = readFileSync(new URL('./patch.mjs', import.meta.url), 'utf8').replace(
      '// ─── Main',
      `patches.length = 0;
patches.push({ id: 'tool-result-pairing-recovery', name: 'AST only test', ast: true });
for (const key of Object.keys(FEATURES)) delete FEATURES[key];
// ─── Main`,
    );
    writeFileSync(join(testDir, 'patch.mjs'), patcher);
    const source = `
      const kks = "[Tool result missing due to internal error]";
      function permissionErrors(history, ids) {
        void history.length;
        const kks = "Permission denied";
        return ids.map(item => ({
          type: "tool_result", tool_use_id: item,
          content: kks, is_error: true
        }));
      }
      function ensureToolResultPairing(conversationHistory, runtimeOpts) {
        let count = conversationHistory.length;
        let Re = ["call_1", "call_missing"];
        let kks = "[Tool result missing due to internal error]";
        let De=Re.map((conversationHistory)=>({type:"tool_result",tool_use_id:conversationHistory,content:kks,is_error:!0}));
        return De;
      }
    `;
    const target = join(testDir, 'cli.original.cjs');
    writeFileSync(target, source);
    const output = execFileSync(process.execPath, [join(testDir, 'patch.mjs')], { encoding: 'utf8' });
    assert.match(output, /AST only test \(1 replacement in 1 file\)/);
    assert.match(output, /Result: 1 applied, 0 skipped, 0 failed/);
    assert.ok(
      readFileSync(target, 'utf8').includes('for(let _m of conversationHistory)'),
      'AST edit must be written when every selected work item is AST',
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
  console.log('[patch.test] AST-only selection flushes pending AST edits ok');
}
