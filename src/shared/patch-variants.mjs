/**
 * Logical patch model.
 *
 * The registry in patch.mjs holds logical patches. A logical patch id is what
 * FEATURES references and what the runtime gate table
 * (globalThis.__clawgodPatches) is keyed by. Each logical patch owns one or
 * more variants: mutually exclusive implementations of the same behavior,
 * selected by the installed Claude Code version.
 *
 * Two authoring forms are accepted:
 *   flat    { id, name, toggleable?, pattern, replacer, ... }
 *   grouped { id, name, toggleable?, variants: [{ pattern, replacer, ... }] }
 *
 * A flat entry normalizes to a logical patch with one implicit variant, so
 * converting an existing patch into a grouped one is a pure data change.
 *
 * Work items carry the logical id, which is also the AST matcher key. Every
 * AST variant of a logical patch shares that matcher, so the matcher must
 * cover the shapes used across the variant's supported versions. Variant
 * replacers gate on the logical id, because the runtime gate table is
 * computed per logical patch.
 *
 * Variant version bounds (`since` / `until`) are inclusive. The installed
 * version selects at most one variant per logical patch; gaps are allowed and
 * overlapping ranges are rejected by validateRegistry(). Unversioned variants
 * match any version, including an unreadable version string.
 */

const LOGICAL_FIELDS = new Set(['id', 'name', 'toggleable', 'variants']);
const VERSION_RE = /^\d+(?:\.\d+)*$/;

function parseVersion(value) {
  if (typeof value !== 'string' || !VERSION_RE.test(value)) return null;
  return value.split('.').map(Number);
}

function compareVersions(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function inRange(version, variant) {
  const hasSince = variant.since !== undefined;
  const hasUntil = variant.until !== undefined;
  if (!hasSince && !hasUntil) return true;
  if (version === null) return false;
  if (hasSince) {
    const since = parseVersion(variant.since);
    if (since === null || compareVersions(version, since) < 0) return false;
  }
  if (hasUntil) {
    const until = parseVersion(variant.until);
    if (until === null || compareVersions(version, until) > 0) return false;
  }
  return true;
}

// Two inclusive ranges overlap unless one ends strictly before the other
// starts. Missing bounds are open, so they never create a gap.
function rangesOverlap(a, b) {
  if (a.until !== undefined && b.since !== undefined &&
      compareVersions(parseVersion(a.until), parseVersion(b.since)) < 0) {
    return false;
  }
  if (b.until !== undefined && a.since !== undefined &&
      compareVersions(parseVersion(b.until), parseVersion(a.since)) < 0) {
    return false;
  }
  return true;
}

function variantLabel(variant, index) {
  const bounds = [];
  if (variant.since !== undefined) bounds.push(`since ${variant.since}`);
  if (variant.until !== undefined) bounds.push(`until ${variant.until}`);
  return `#${index + 1}${bounds.length > 0 ? ` (${bounds.join(', ')})` : ' (unbounded)'}`;
}

// Returns whether the bounds are usable for overlap comparison. Invalid or
// inverted bounds are reported and excluded from the pairwise check.
function validateVariantRange(id, variant, errs) {
  let valid = true;
  if (variant.since !== undefined && parseVersion(variant.since) === null) {
    errs.push(`variant of '${id}' has invalid since ${JSON.stringify(variant.since)}`);
    valid = false;
  }
  if (variant.until !== undefined && parseVersion(variant.until) === null) {
    errs.push(`variant of '${id}' has invalid until ${JSON.stringify(variant.until)}`);
    valid = false;
  }
  if (valid && variant.since !== undefined && variant.until !== undefined &&
      compareVersions(parseVersion(variant.since), parseVersion(variant.until)) > 0) {
    errs.push(`variant of '${id}' has since after until`);
    valid = false;
  }
  return valid;
}

// Raw entries -> logical patches. Malformed entries pass through so
// validateRegistry() can report them instead of throwing here.
export function normalizePatches(entries) {
  return entries.map((entry) => {
    if (!Array.isArray(entry.variants)) {
      const { id, name, toggleable, ...behavior } = entry;
      return {
        id,
        name,
        toggleable: toggleable === true,
        variants: [behavior],
      };
    }
    return {
      id: entry.id,
      name: entry.name,
      toggleable: entry.toggleable === true,
      variants: entry.variants.map((variant) => ({ ...variant })),
    };
  });
}

// Logical patches -> executable work items, preserving registry order.
export function expandPatches(logicalPatches) {
  const items = [];
  for (const patch of logicalPatches) {
    for (const variant of patch.variants) {
      items.push({ ...variant, id: patch.id, name: patch.name });
    }
  }
  return items;
}

// Logical patches -> the same patches with only the variants whose inclusive
// version range contains the installed version. Validation guarantees at most
// one variant survives per patch; a patch with none is out of range and
// omitted.
export function selectVariants(logicalPatches, version) {
  const parsed = parseVersion(version);
  return logicalPatches
    .map((patch) => ({
      ...patch,
      variants: patch.variants.filter((variant) => inRange(parsed, variant)),
    }))
    .filter((patch) => patch.variants.length > 0);
}

// Authoring guardrail. Returns human-readable errors; the caller aborts before
// touching any file. Covers the feature contract and the variant schema.
export function validateRegistry({ patches, features, astPatchIds }) {
  const errs = [];
  const astIds = new Set(astPatchIds);
  const byId = new Map();

  for (const entry of patches) {
    if (!entry.id) errs.push(`patch without id: ${entry.name}`);
    else if (byId.has(entry.id)) errs.push(`duplicate patch id: ${entry.id}`);
    else byId.set(entry.id, entry);
  }

  for (const entry of patches) {
    const id = entry.id || entry.name;
    if (entry.variants !== undefined && !Array.isArray(entry.variants)) {
      errs.push(`patch '${id}' has non-array variants`);
      continue;
    }
    if (!Array.isArray(entry.variants)) {
      validateVariantRange(id, entry, errs);
      if (entry.ast) {
        if (!astIds.has(id)) {
          errs.push(`AST variant of '${id}' has no matcher in AST_PATCH_IDS`);
        }
      } else if (!(entry.pattern instanceof RegExp)) {
        errs.push(`patch '${id}' has no pattern`);
      } else if (typeof entry.replacer !== 'function') {
        errs.push(`patch '${id}' has no replacer`);
      }
      continue;
    }
    if (entry.variants.length === 0) errs.push(`grouped patch '${id}' has no variants`);
    for (const field of Object.keys(entry)) {
      if (!LOGICAL_FIELDS.has(field)) {
        errs.push(`grouped patch '${id}' has field '${field}' outside variants`);
      }
    }
    const ranges = [];
    let hasAst = false;
    for (const variant of entry.variants) {
      for (const field of Object.keys(variant)) {
        if (LOGICAL_FIELDS.has(field)) {
          errs.push(`variant of '${id}' has logical field '${field}'`);
        }
      }
      ranges.push(validateVariantRange(id, variant, errs));
      if (variant.ast) {
        hasAst = true;
        continue;
      }
      if (!(variant.pattern instanceof RegExp)) {
        errs.push(`variant of '${id}' has no pattern`);
      } else if (typeof variant.replacer !== 'function') {
        errs.push(`variant of '${id}' has no replacer`);
      }
    }
    for (let i = 0; i < entry.variants.length; i++) {
      if (!ranges[i]) continue;
      for (let j = i + 1; j < entry.variants.length; j++) {
        if (!ranges[j]) continue;
        if (rangesOverlap(entry.variants[i], entry.variants[j])) {
          errs.push(`grouped patch '${id}' has overlapping variants ${variantLabel(entry.variants[i], i)} and ${variantLabel(entry.variants[j], j)}`);
        }
      }
    }
    if (hasAst && !astIds.has(id)) {
      errs.push(`AST variant of '${id}' has no matcher in AST_PATCH_IDS`);
    }
  }

  for (const [fid, def] of Object.entries(features)) {
    for (const pid of def.patchIds) {
      const entry = byId.get(pid);
      if (!entry) { errs.push(`feature '${fid}' references unknown patch id '${pid}'`); continue; }
      if (entry.toggleable !== true) errs.push(`feature '${fid}' references non-toggleable patch '${pid}'`);
    }
  }
  for (const entry of patches) {
    const referenced = Object.values(features).some((f) => f.patchIds.includes(entry.id));
    if (entry.toggleable === true && !referenced) {
      errs.push(`toggleable patch '${entry.id}' is referenced by no feature`);
    }
  }
  return errs;
}
