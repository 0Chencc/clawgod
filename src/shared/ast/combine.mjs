// Combination for AST patch modules: layered application with per-id
// verification and idempotency. The caller injects the raw scanner, the edit
// applicator, the parser and the id list, so this file owns no legacy code and
// survives when the inline scan is replaced.
import { verifyModule } from './engine.mjs';

// Effective edits change the source; no-op matches never reach the applicator.
const effectiveMatches = (code, matches) =>
  matches.filter(match => match.replacement !== code.slice(match.start, match.end));

// Whether two edits collide for combination purposes. Same-offset zero-width
// edits collide even though the applicator itself would write both.
const overlaps = (a, b) =>
  (a.start === a.end && b.start === b.end && a.start === b.start) ||
  (a.start < b.end && b.start < a.end);

// First colliding pair, walked in the applicator's sort order. Same-offset
// zero-width pairs are listed separately because a plain range comparison
// sees them as non-overlapping.
function overlappingPair(edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const previous = sorted[i - 1], edit = sorted[i];
    if (previous && previous.start === previous.end && edit.start === edit.end &&
        previous.start === edit.start) return [previous, edit];
    if (edit.start < cursor) return [previous, edit];
    cursor = edit.end;
  }
  return null;
}

export function createAstCombination({ ids, scanRaw, applyEdits, parse }) {
  const effectiveEdits = (code, scan) =>
    new Map(ids.map(id => [id, effectiveMatches(code, scan[id].matches)]));

  // One id's effective edits form one group. A group that overlaps itself
  // cannot be applied without choosing a subset, so it is an implementation
  // error of that id, never a combination conflict.
  const effectiveGroups = (code, scan) => {
    const effective = effectiveEdits(code, scan);
    for (const [id, edits] of effective) {
      if (overlappingPair(edits)) throw new Error(`AST patch '${id}' produced overlapping edits`);
    }
    return effective;
  };

  // Combination is only needed when two different ids collide. A group that
  // overlaps itself alone keeps its historical path: the raw scan is returned,
  // so range overlaps still fail in the applicator exactly as before and
  // same-offset zero-width pairs still apply as they always did. Once any
  // cross-id overlap forces combination, every participant's group is checked
  // first, so a self-overlapping module can never be rescued by an earlier
  // layer.
  const crossIdOverlap = effective => {
    const groups = [...effective].filter(([, edits]) => edits.length > 0);
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        for (const a of groups[i][1]) {
          for (const b of groups[j][1]) if (overlaps(a, b)) return true;
        }
      }
    }
    return false;
  };

  // In-memory patcher for one file. Files whose effective edits stay inside
  // their owning ids keep the historical single-batch rewrite; files with a
  // cross-id overlap apply one id group per layer, re-parsing in between, so
  // a later id sees the text an earlier one produced. Combination is refused
  // rather than guessed whenever a participant cannot prove its own result.
  const compose = (code, scan, effective, modules) => {
    const participants = ids.filter(id => effective.get(id).length > 0);
    const combined = participants.flatMap(id => effective.get(id).map(edit => ({ ...edit, id })));
    // Scan fields are the initial-layer ones; applied counts this id's edits
    // that reached the published text (0 when the file is refused).
    const results = appliedFor => Object.fromEntries(ids.map(id =>
      [id, { ...scan[id], applied: appliedFor(id) }]));
    const appliedCounts = Object.fromEntries(ids.map(id => [id, 0]));
    const conflict = (conflictIds, reason) => ({ code, results: results(() => 0), conflict: { ids: conflictIds, reason } });

    if (!overlappingPair(combined)) {
      // Fast path: byte-identical to collecting every id's edits and applying
      // them in one batch, which is what the runner did before combination.
      const finalCode = applyEdits(code, combined);
      // The historical rewrite validated its product before publishing it.
      if (combined.length) parse(finalCode);
      for (const id of participants) appliedCounts[id] = effective.get(id).length;
      return { code: finalCode, results: results(id => appliedCounts[id]), conflict: null };
    }

    // Layered path. Only modules can combine: an inline id has no completion
    // contract, so the whole file is refused before anything is applied.
    const byId = new Map(modules.map(module => [module.id, module]));
    const legacy = participants.filter(id => !byId.has(id));
    if (legacy.length) return conflict(legacy, 'legacy patch cannot participate in combination');
    const unverified = participants.filter(id => typeof byId.get(id).verify !== 'function');
    if (unverified.length) return conflict(unverified, 'module has no verify');

    // P is the initial-layer participant set. Ids outside it never run again:
    // matches they would find on later layers are ignored, not applied.
    const before = { code, tree: parse(code) };
    const matches = Object.fromEntries(participants.map(id => [id, effective.get(id)]));
    let layer = code;
    for (const id of participants) {
      // Exactly one whole group per id: the layer is re-parsed, so this id's
      // matcher sees earlier output and its coordinates belong to this layer.
      const edits = effectiveMatches(layer, scanRaw(layer, [byId.get(id)])[id].matches);
      if (overlappingPair(edits)) throw new Error(`AST patch '${id}' produced overlapping edits`);
      // Zero effective edits here is not completion: the id stays in P, keeps
      // applied 0, and its verify still has to pass on the final text.
      if (!edits.length) continue;
      layer = applyEdits(layer, edits);
      appliedCounts[id] = edits.length;
    }
    const after = { code: layer, tree: parse(layer) };
    const unproven = participants.filter(id =>
      !verifyModule(byId.get(id), { before, after, matches: matches[id] }));
    if (unproven.length) return conflict(unproven, 'lost or unverified target');
    // Idempotency: every participant must be settled on the final text, or a
    // second run would change the file again. A stale rescan is not settled
    // either: the matcher found a site it cannot handle, and the next run
    // would refuse the file instead of skipping it.
    const unsettled = participants.filter(id => {
      const rescan = scanRaw(after.code, [byId.get(id)])[id];
      return rescan.stale || effectiveMatches(after.code, rescan.matches).length > 0;
    });
    if (unsettled.length) return conflict(unsettled, 'idempotency check failed');
    return { code: layer, results: results(id => appliedCounts[id]), conflict: null };
  };

  // Explicit entry for callers that want the composed text plus per-id applied
  // counts; tests drive the combination contract through it.
  const transform = (code, modules) => {
    const scan = scanRaw(code, modules);
    return compose(code, scan, effectiveGroups(code, scan), modules);
  };

  // Runner-facing scan. Files whose ids never overlap keep the historical
  // per-id match lists byte for byte, so the old runner's collect-then-apply
  // flush is untouched. A file with a cross-id overlap is composed here and
  // reported as one whole-file replacement credited to the first participating
  // id; the other participants keep their matches but as no-ops (the composed
  // text already contains them). The old runner skips no-op matches, yet a
  // non-empty match list still keeps a `present` id out of its stale branch,
  // so the composed text is applied exactly once, at the price of
  // under-reporting which ids participated in that file and of surfacing a
  // refused combination as a generic "AST scan failed" (no file is written
  // either way).
  const scan = (code, modules) => {
    const raw = scanRaw(code, modules);
    const effective = effectiveEdits(code, raw);
    if (!crossIdOverlap(effective)) return raw;
    // Composed files validate every participant up front: a self-overlapping
    // group is that id's implementation error even when a later layer would
    // have replaced the text it came from.
    const composed = compose(code, raw, effectiveGroups(code, raw), modules);
    if (composed.conflict) {
      throw new Error(`AST combination conflict: ${composed.conflict.reason} ` +
        `(${composed.conflict.ids.join(', ')})`);
    }
    const credited = ids.find(id => effective.get(id).length > 0);
    const folded = Object.fromEntries(ids.map(id => [id, { ...raw[id] }]));
    for (const id of ids) {
      if (id === credited || effective.get(id).length === 0) continue;
      folded[id].matches = raw[id].matches.map(match =>
        ({ ...match, replacement: code.slice(match.start, match.end) }));
    }
    // The whole-file edit reproduces the composed text in one step.
    folded[credited].matches = [{ start: 0, end: code.length, replacement: composed.code }];
    return folded;
  };

  return { transform, scan };
}
