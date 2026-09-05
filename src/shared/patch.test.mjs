// Unit tests for classifierTimeoutFloor — the pure value parser behind the
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
