'use strict';
// Runtime helpers shared by injected patches, exposed on
// globalThis.__clawgodHelpers. The patched cli.original.cjs lives in its own
// module scope, so it reaches these helpers only through globalThis.
//
// cli.cjs requires this module once at launch; after that, adding a new
// helper means editing this single file — no build.js / cli.cjs / template
// changes. (feature-gates.cjs is a future merge target here.)
//
// These are value parsers only: the injected patch code owns its own gating
// (globalThis.__clawgodPatches?.[...]) and env reads, and feeds the raw
// value in here for parsing/validation.

// Parses a CLAWGOD_CLASSIFIER_TIMEOUT_MS value to a finite number, or null
// when it cannot be parsed (missing/blank/non-numeric/Infinity/overflow). The
// caller decides the fallback: the injected patch code checks for null
// explicitly and keeps the original formula, while any real number — a
// legitimate "0" included — is applied as a floor. Returning null (not 0)
// keeps "0" as a real override and never conflates it with a parse failure.
function classifierTimeoutFloor(envValue) {
  if (typeof envValue === 'string' && envValue.trim() === '') return null;
  const value = Number(envValue);
  return Number.isFinite(value) ? value : null;
}

// The runtime container (globalThis.__clawgodHelpers) IS the module's own
// exports, so a new helper only needs an export line here to be reachable
// from the patched bundle — no separate registration object. We expose
// module.exports, not module (the latter carries id/filename/paths metadata).
module.exports.classifierTimeoutFloor = classifierTimeoutFloor;
globalThis.__clawgodHelpers = module.exports;
