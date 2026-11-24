// Engine for migrated AST patch modules: validates the module table, indexes
// the already-parsed tree once, and dispatches modules whose anchors appear.
// A module with empty anchors opts out of the prefilter and runs on every
// parsed file.
import { walk } from './common.mjs';

// A module namespace may only expose these names. Anything else is a typo or
// an undeclared contract, and must fail before any file is touched.
const MODULE_EXPORTS = new Set(['id', 'anchors', 'evidence', 'scan', 'verify']);

// Spread first so a sparse array cannot slip through: every() skips holes.
const isStringList = value => Array.isArray(value) && value.length > 0 &&
  [...value].every(item => typeof item === 'string' && item.length > 0);
// Anchors may be empty, which means "no prefilter": the module runs on every
// parsed file. Every element must still be a non-empty string.
const isAnchorList = value => Array.isArray(value) &&
  [...value].every(item => typeof item === 'string' && item.length > 0);

// Validate the ordered module table at startup. `ids` is AST_PATCH_IDS: every
// module owns an existing result, and the remaining ids belong to the inline
// scan. `anchors` is the inline prefilter list: a module may narrow it only
// when its matcher cannot see anything the prefilter misses, and a new anchor
// would widen the set of parsed files. Violations throw immediately, mirroring
// the registry self-check in patch.mjs.
export function defineModules(entries, ids, anchors) {
  const known = new Set(ids);
  const legacyAnchors = new Set(anchors);
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new Error('AST patch module must be an object');
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new Error('AST patch module must export a non-empty string id');
    }
    // Own properties only: inherited id/scan/anchors are not a module export.
    if (!Object.hasOwn(entry, 'id') || !Object.hasOwn(entry, 'anchors') || !Object.hasOwn(entry, 'scan')) {
      throw new Error(`AST patch module '${entry.id}' must export id, anchors and scan`);
    }
    for (const name of Object.keys(entry)) {
      if (!MODULE_EXPORTS.has(name)) {
        throw new Error(`AST patch module '${entry.id}' exports unsupported name '${name}'`);
      }
    }
    if (typeof entry.scan !== 'function') throw new Error(`AST patch module '${entry.id}' must export scan`);
    if (!isAnchorList(entry.anchors)) {
      throw new Error(`AST patch module '${entry.id}' must export an anchors array of non-empty strings; an empty array means no prefilter`);
    }
    for (const anchor of entry.anchors) {
      if (!legacyAnchors.has(anchor)) {
        throw new Error(`AST patch module '${entry.id}' anchor '${anchor}' is not in the legacy anchors list`);
      }
    }
    if (entry.evidence !== undefined && !isStringList(entry.evidence)) {
      throw new Error(`AST patch module '${entry.id}' must export evidence as a non-empty array of non-empty strings`);
    }
    // verify is optional; a present but non-callable export would only fail
    // later, once a conflicting file reaches layered combination.
    if (entry.verify !== undefined && typeof entry.verify !== 'function') {
      throw new Error(`AST patch module '${entry.id}' must export verify as a function`);
    }
    if (!known.has(entry.id)) {
      throw new Error(`AST patch module '${entry.id}' is not listed in AST_PATCH_IDS`);
    }
    if (seen.has(entry.id)) throw new Error(`duplicate AST patch id: ${entry.id}`);
    seen.add(entry.id);
  }
  return entries;
}

// Runs the migrated modules on the tree the inline scan just walked. A
// module's own result object is its only write target: edit is bound to it,
// so a module cannot write another id's state.
export function runModules({ code, tree, functions, results, modules }) {
  // Nodes bucketed by type in traversal order. The index is only built when
  // the caller saw at least one module anchor in this file, or a module with
  // empty anchors selected itself for every file.
  const index = new Map();
  walk(tree, node => {
    const bucket = index.get(node.type);
    if (bucket) bucket.push(node);
    else index.set(node.type, [node]);
  });
  // Freeze the shared buckets so one module cannot mutate another's view.
  for (const bucket of index.values()) Object.freeze(bucket);
  const nodes = type => index.get(type) ?? [];
  for (const module of modules) {
    if (!(module.anchors.length === 0 || module.anchors.some(anchor => code.includes(anchor)))) continue;
    const result = results[module.id];
    // A migrated id must be gone from the inline scan. If it is not, the
    // module would silently double-write, so fail with the id that leaked.
    if (result.matches.length || result.present || result.patched) {
      throw new Error(`AST patch '${module.id}' was already written by the inline scan; remove its branch there`);
    }
    // Once a module declares a site stale, its collected edits are discarded
    // and later edits are ignored.
    const edit = (node, replacement) => {
      if (result.stale) return;
      result.matches.push({ start: node.start, end: node.end, replacement });
    };
    const stale = (node, reason) => {
      result.stale = { start: node.start, end: node.end, reason };
      result.matches = [];
      // The runner diagnoses stale matchers through present ("candidate site
      // found but unhandled"). Without it an empty match list reads as "not
      // present in this version" and the drift is silently skipped.
      result.present = true;
    };
    module.scan({ code, tree, nodes, functions, result, edit, stale });
  }
}

// Combination asks a module to prove its own result after layered application.
// The protocol (strict `true`, no shape guessing) stays in the engine so the
// combiner never inspects a module directly.
export function verifyModule(module, input) {
  if (typeof module.verify !== 'function') {
    throw new Error(`AST patch module '${module.id}' exports no verify`);
  }
  return module.verify(input) === true;
}
