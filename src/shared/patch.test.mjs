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
  for (const name of ['patch.mjs', 'ast-patches.mjs', 'acorn.mjs']) {
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
    for (const [label, condition] of [
      ['inline provider', 'provider!=="firstParty"&&!isAws(provider)&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku"))'],
      ['provider helper', 'isThirdParty()&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku"))'],
      ['provider helper with haiku exemption (v2.1.293+)', 'isThirdParty()&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku")&&model!=="claude-haiku-5-5")'],
      ['provider helper with future exclusions', 'isThirdParty()&&(model==="claude-opus-4-6"||model==="claude-sonnet-4-6"||model.includes("haiku")&&model!=="claude-haiku-5-5"&&!isExcluded(model))'],
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
  for (const name of ['patch.mjs', 'ast-patches.mjs', 'acorn.mjs']) {
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
