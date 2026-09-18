'use strict';
// Runtime helpers shared by injected patches, exposed on
// globalThis.__clawgodHelpers. The patched cli.original.cjs lives in its own
// module scope, so it reaches these helpers only through globalThis.
//
// cli.cjs requires this module once at launch; after that, adding a new
// helper means editing this single file — no build.js / cli.cjs / template
// changes. (feature-gates.cjs is a future merge target here.)
//
// Helpers return values only: injected code owns gating, env reads, timers,
// and mutation of the renderer's state.

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

// A DA1 reply can arrive in multiple stdin reads (issue #171). The renderer
// normally flushes incomplete escapes after 50ms, which turns a split ESC [
// into a key and lets the reply's suffix reach the text input. While a DA1
// sentinel is outstanding, allow the same 2s inter-read budget upstream uses
// for recognized control-sequence prefixes. This also covers 2.1.263, whose
// longer-prefix handling predates that upstream fix.
//
// Do not filter input: ordinary keys, paste, and complete sequences still go
// through the existing parser immediately. A lone Escape or Alt+[ during a
// pending probe is delayed, then passed to the original parser on timeout.
// With no outstanding probe, even those keys retain their usual timing.
function terminalReplyDelay(querier, reader, now) {
  const parse = reader?.parse;
  if (parse?.mode !== 'NORMAL' || typeof parse.incomplete !== 'string') return 0;
  if (!/^\x1b(?:\[(?:\?[\d;]*)?)?$/.test(parse.incomplete)) return 0;
  // 2.1.263 writes queue entries immediately. 2.1.274 adds `written`, and
  // may queue probes before stdin attaches; those cannot have replies yet.
  if (!Array.isArray(querier?.queue) || !querier.queue.some((entry) =>
    entry?.kind === 'barrier' || (entry?.kind === 'sentinel' && entry.written !== false))) return 0;
  if (!Number.isFinite(now) || !Number.isFinite(reader.lastInputAt)) return 0;
  return Math.max(0, 2000 - Math.max(0, now - reader.lastInputAt));
}

// The runtime container (globalThis.__clawgodHelpers) IS the module's own
// exports, so a new helper only needs an export line here to be reachable
// from the patched bundle — no separate registration object. We expose
// module.exports, not module (the latter carries id/filename/paths metadata).
module.exports.classifierTimeoutFloor = classifierTimeoutFloor;
module.exports.terminalReplyDelay = terminalReplyDelay;
globalThis.__clawgodHelpers = module.exports;
