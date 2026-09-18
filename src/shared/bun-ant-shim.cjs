'use strict';
/**
 * clawgod — `Bun.ant` runtime shim.
 *
 * Claude Code 2.1.271 moved its Ink renderer onto `Bun.ant.CellSegmenter`, an
 * Anthropic-private Bun API that ships only inside the bundled native binary.
 * clawgod runs the extracted JS bundle on the user's own Bun, which has no
 * `Bun.ant` namespace, so the renderer threw before the first frame: the TUI
 * never painted while the process stayed alive and looked hung (issue #183).
 * The native binary (`claude.orig`) was unaffected.
 *
 * This module implements the API surface the renderer consumes. cli.cjs loads
 * it before cli.original.cjs, and it no-ops when the real API is present.
 *
 * Contract (reverse-engineered from the 2.1.271+ bundle, pinned by
 * bun-ant-shim.test.mjs):
 *
 *   new CellSegmenter({ ambiguousIsNarrow, substitute, screen, tabWidth })
 *   .graphemes / .sgrKeys / .sgrCloseKeys / .uris   per-run tables, strings
 *   .segment(text, cellsOut, runsOut, reordered) -> cell count
 *       cellsOut: 2 int32 per cell — [graphemeIndex, (run << 10) | tab | width]
 *       runsOut:  2 int32 per run  — [styleId, uriIndex]
 *       Negative return = required cell capacity (caller reallocates).
 *   .paint(targetCells, targetWidth, x, y, cells, count, _unused, charMap, words)
 *   .setCell(targetCells, targetWidth, x, y, charId, packedStyle)
 *       Both return end * 2^36 + first * 2^20 + end for a nonempty span.
 *       I0() decodes the upper fields as damage bounds; j0()/xC() return the
 *       low field as the absolute ending column for soft-wrap metadata.
 *
 * The `substitute` option (bidi control ranges) needs no handling: the controls
 * are zero width already, which is what the option asks for.
 *
 * The tables are mutated in place: the bundle caches the four arrays once per
 * renderer instance. SGR state persists across segment() calls, so a style
 * spanning a wrapped line survives.
 *
 * Toggle: patches.json {"bun-ant-shim": false} or CLAWGOD_FEATURE_BUN_ANT_SHIM=false
 */

const SCREEN_DEFAULTS = {
  widthMask: 3, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3,
  emptyCharIndex: 0, spacerCharIndex: 1, tabWidth: 8,
};

const STYLE_SHIFT = 17;
const LINK_SHIFT = 2;
const LINK_MASK = 32767;
const WIDTH_MASK = 255;
const TAB_FLAG = 256;
const RUN_SHIFT = 10;
const DAMAGE_SPAN = 1048576; // 2^20 — field holding the first column
const DAMAGE_END = 68719476736; // 2^36 — field holding the end column

// SGR attributes that occupy one style slot, as param -> [slot, closeParam].
// The bundle's style pool only accepts single-parameter codes, so combined
// sequences are split below.
const SGR_ATTRS = new Map([
  [1, ['bold', 22]],
  [2, ['dim', 22]],
  [3, ['italic', 23]],
  [4, ['underline', 24]],
  [5, ['blink', 25]],
  [6, ['blink-fast', 25]],
  [7, ['inverse', 27]],
  [8, ['hidden', 28]],
  [9, ['strike', 29]],
  [21, ['underline-double', 24]],
  [53, ['overline', 55]],
]);

// Closing params, as closeParam -> slots it clears (22 and 24 each cover the
// two attributes they close).
const SGR_CLOSES = new Map([
  [22, ['bold', 'dim']],
  [23, ['italic']],
  [24, ['underline', 'underline-double']],
  [25, ['blink', 'blink-fast']],
  [27, ['inverse']],
  [28, ['hidden']],
  [29, ['strike']],
  [39, ['fg']],
  [49, ['bg']],
  [55, ['overline']],
  [59, ['underline-color']],
]);

// Extended colours (38/48/58) and the 30-37/90-97 fg, 40-47/100-107 bg ranges.
const SGR_EXTENDED = new Map([
  [38, ['fg', 39]],
  [48, ['bg', 49]],
  [58, ['underline-color', 59]],
]);

function slotFor(param) {
  const attr = SGR_ATTRS.get(param);
  if (attr) return attr;
  const extended = SGR_EXTENDED.get(param);
  if (extended) return extended;
  if ((param >= 30 && param <= 37) || (param >= 90 && param <= 97)) return ['fg', 39];
  if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) return ['bg', 49];
  return null;
}

function sgrCode(params) {
  return '\x1b[' + params + 'm';
}

// ─── Grapheme segmentation & width ───────────────────────────

let graphemeSegmenter;
let graphemeSegmenterResolved = false;

function graphemeIterator() {
  if (!graphemeSegmenterResolved) {
    graphemeSegmenterResolved = true;
    try {
      graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      graphemeSegmenter = null;
    }
  }
  return graphemeSegmenter;
}

// Approximate East Asian Wide/Fullwidth + emoji ranges, used only when
// Bun.stringWidth is unavailable (the CI unit test runs under plain Node).
const FALLBACK_WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;

function fallbackWidth(grapheme) {
  if (/^\p{M}+$/u.test(grapheme)) return 0;
  for (const ch of grapheme) if (FALLBACK_WIDE.test(ch)) return 2;
  return 1;
}

function graphemeWidth(grapheme, ambiguousIsNarrow) {
  const bun = typeof Bun === 'object' && Bun !== null ? Bun : undefined;
  if (bun && typeof bun.stringWidth === 'function') {
    try {
      const width = bun.stringWidth(grapheme, { ambiguousIsNarrow: ambiguousIsNarrow === true });
      if (Number.isFinite(width) && width >= 0) return width | 0;
    } catch {}
  }
  return fallbackWidth(grapheme);
}

// ─── Escape scanner ─────────────────────────────────────────

// Text, SGR, OSC-8 hyperlinks, and any other escape (dropped — a `write` op
// only carries styling).
const ESCAPE_SCAN = /\x1b\[([0-9;]*)m|\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[@-~]|\x1b[@-Z\\-_]/g;

function scanChunks(text) {
  const chunks = [];
  let last = 0;
  ESCAPE_SCAN.lastIndex = 0;
  for (let match; (match = ESCAPE_SCAN.exec(text)) !== null; ) {
    if (match.index > last) chunks.push({ kind: 'text', value: text.slice(last, match.index) });
    if (match[1] !== undefined) chunks.push({ kind: 'sgr', value: match[1] });
    else if (match[3] !== undefined) chunks.push({ kind: 'osc8', value: match[3] });
    last = match.index + match[0].length;
  }
  if (last < text.length) chunks.push({ kind: 'text', value: text.slice(last) });
  return chunks;
}

// ─── CellSegmenter ──────────────────────────────────────────

class CellSegmenter {
  constructor(options) {
    const opts = options || {};
    const screen = opts.screen || {};
    this.ambiguousIsNarrow = opts.ambiguousIsNarrow !== false;
    this.tabWidth = Number.isFinite(opts.tabWidth) && opts.tabWidth > 0 ? opts.tabWidth | 0 : SCREEN_DEFAULTS.tabWidth;
    const kind = (key) => screen[key] ?? SCREEN_DEFAULTS[key];
    this.kinds = {
      narrow: kind('narrow'), wide: kind('wide'),
      spacerTail: kind('spacerTail'), spacerHead: kind('spacerHead'),
    };
    this.emptyCharIndex = kind('emptyCharIndex');
    this.spacerCharIndex = kind('spacerCharIndex');

    // Mutated in place — the renderer caches these arrays per instance.
    this.graphemes = [' ', ''];
    this.sgrKeys = [''];
    this.sgrCloseKeys = [''];
    this.uris = [''];

    this._graphemeIndex = new Map([[' ', 0], ['', 1]]);
    this._styleIndex = new Map();
    this._uriIndex = new Map();
    this._style = new Map();
  }

  _uriIndexFor(uri) {
    let id = this._uriIndex.get(uri);
    if (id === undefined) {
      id = this.uris.length;
      this.uris.push(uri);
      this._uriIndex.set(uri, id);
    }
    return id;
  }

  _applySgr(params) {
    const parts = params.split(';');
    for (let i = 0; i < parts.length; i += 1) {
      const raw = parts[i];
      const param = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(param)) continue;
      if (param === 0) {
        this._style.clear();
        continue;
      }
      const closes = SGR_CLOSES.get(param);
      if (closes) {
        for (const slot of closes) this._style.delete(slot);
        continue;
      }
      const extended = SGR_EXTENDED.get(param);
      if (extended) {
        // 38/48/58 take "5;n" or "2;r;g;b" operands. Consume them here so the
        // loop does not read the operands as attribute params.
        const mode = parts[i + 1];
        let code;
        if (mode === '5' && parts[i + 2] !== undefined) {
          code = sgrCode(param + ';5;' + parts[i + 2]);
          i += 2;
        } else if (mode === '2' && parts[i + 4] !== undefined) {
          code = sgrCode(param + ';2;' + parts[i + 2] + ';' + parts[i + 3] + ';' + parts[i + 4]);
          i += 4;
        } else {
          code = sgrCode(param);
        }
        this._style.set(extended[0], { code, close: sgrCode(extended[1]) });
        continue;
      }
      const slotEntry = slotFor(param);
      if (slotEntry) {
        this._style.set(slotEntry[0], { code: sgrCode(param), close: sgrCode(slotEntry[1]) });
      } else {
        // Unknown attribute: keep it as its own slot so the transition to the
        // next style still closes it where the terminal understands the code.
        this._style.set('param-' + param, { code: sgrCode(param), close: '' });
      }
    }
  }

  _styleId() {
    if (this._style.size === 0) return 0;
    const pairs = [];
    for (const entry of this._style.values()) pairs.push(entry.code + '\u0000' + entry.close);
    // Sort so the same attribute set reached via different SGR orderings
    // (e.g. "1;7" vs "7;1") shares one style id instead of bloating the table.
    pairs.sort();
    const codes = pairs.map((pair) => pair.slice(0, pair.indexOf('\u0000')));
    const closes = pairs.map((pair) => pair.slice(pair.indexOf('\u0000') + 1));
    const key = codes.length + '|' + codes.join('\u0000') + '|' + closes.join('\u0000');
    let id = this._styleIndex.get(key);
    if (id === undefined) {
      // IDs must remain stable for this instance: the renderer caches their
      // resolved styles, and the current segment() may already reference them.
      // The caller owns capacity/generation checks and rebuilds the segmenter
      // together with its caches; never truncate these tables independently.
      id = this.sgrKeys.length;
      this.sgrKeys.push(codes.join('\u0000'));
      this.sgrCloseKeys.push(closes.join('\u0000'));
      this._styleIndex.set(key, id);
    }
    return id;
  }

  _graphemeId(grapheme) {
    let id = this._graphemeIndex.get(grapheme);
    if (id === undefined) {
      id = this.graphemes.length;
      this.graphemes.push(grapheme);
      this._graphemeIndex.set(grapheme, id);
    }
    return id;
  }

  segment(text, cells, runs /* , reordered */) {
    const source = typeof text === 'string' ? text : text == null ? '' : String(text);
    const items = [];
    let link = 0;
    // The bundle re-runs segment() with grown arrays when this returns a
    // negative count. _applySgr advances the persistent _style map, so a
    // capacity-fail run must roll it back or the retry would re-apply the SGR
    // codes on top of the already-advanced state and mis-style the leading
    // text. _applySgr only set()s fresh objects / delete()s / clear()s, so a
    // shallow copy is a faithful snapshot.
    const styleSnapshot = new Map(this._style);

    const push = (grapheme) => {
      const isTab = grapheme === '\t';
      items.push({
        graphemeIndex: this._graphemeId(grapheme),
        tab: isTab,
        width: isTab ? 0 : graphemeWidth(grapheme, this.ambiguousIsNarrow),
        style: this._styleId(),
        link,
      });
    };

    const segmenter = graphemeIterator();
    for (const chunk of scanChunks(source)) {
      if (chunk.kind === 'sgr') {
        this._applySgr(chunk.value);
        continue;
      }
      if (chunk.kind === 'osc8') {
        link = chunk.value ? this._uriIndexFor(chunk.value) : 0;
        continue;
      }
      if (segmenter) {
        for (const entry of segmenter.segment(chunk.value)) push(entry.segment);
      } else {
        push(chunk.value);
      }
    }

    const count = items.length;
    if (cells.length < count * 2 || runs.length < count * 2) {
      this._style = styleSnapshot;
      return -count;
    }

    let runCount = 0;
    let previous = null;
    for (let i = 0; i < count; i += 1) {
      const item = items[i];
      if (!previous || previous.style !== item.style || previous.link !== item.link) {
        runs[runCount * 2] = item.style;
        runs[runCount * 2 + 1] = item.link;
        runCount += 1;
        previous = item;
      }
      item.run = runCount - 1;
      cells[i * 2] = item.graphemeIndex;
      cells[i * 2 + 1] = (item.run << RUN_SHIFT) | (item.tab ? TAB_FLAG : 0) | (item.width & WIDTH_MASK);
    }
    return count;
  }

  paint(target, targetWidth, x, y, cells, count, _unused, charMap, words) {
    const columns = targetWidth | 0;
    const emptyCharId = charMap ? charMap[this.emptyCharIndex] | 0 : this.emptyCharIndex;
    const spacerCharId = charMap ? charMap[this.spacerCharIndex] | 0 : this.spacerCharIndex;
    const rowBase = (y | 0) * columns;
    let column = x | 0;
    const first = column;

    for (let i = 0; i < (count | 0); i += 1) {
      const packed = cells[i * 2 + 1];
      const run = packed >>> RUN_SHIFT;
      const word = (words ? words[run] : 0) | 0;
      const style = (word >>> STYLE_SHIFT) << STYLE_SHIFT;
      // runWords() has already removed its cache's +1 sentinel offset.
      const link = (word >>> LINK_SHIFT) & LINK_MASK;
      const styleBits = style | (link << LINK_SHIFT);

      if ((packed & TAB_FLAG) !== 0) {
        const stop = this.tabWidth - (((column % this.tabWidth) + this.tabWidth) % this.tabWidth);
        for (let k = 0; k < stop; k += 1) this._put(target, rowBase, columns, column + k, emptyCharId, styleBits | this.kinds.narrow);
        column += stop;
        continue;
      }

      const width = packed & WIDTH_MASK;
      if (width >= 2) {
        const charId = charMap ? charMap[cells[i * 2]] | 0 : cells[i * 2] | 0;
        this._put(target, rowBase, columns, column, charId, styleBits | this.kinds.wide);
        this._put(target, rowBase, columns, column + 1, spacerCharId, styleBits | this.kinds.spacerTail);
        column += 2;
      } else if (width === 1) {
        const charId = charMap ? charMap[cells[i * 2]] | 0 : cells[i * 2] | 0;
        this._put(target, rowBase, columns, column, charId, styleBits | this.kinds.narrow);
        column += 1;
      }
      // width 0 (combining mark, bidi control): no cell of its own.
    }

    return packDamage(first, column);
  }

  setCell(target, targetWidth, x, y, charId, packedStyle) {
    const columns = targetWidth | 0;
    const column = x | 0;
    const row = y | 0;
    if (column < 0 || column >= columns || row < 0) return 0;
    this._put(target, row * columns, columns, column, charId, packedStyle);
    return packDamage(column, column + 1);
  }

  _put(target, rowBase, columns, column, charId, packed) {
    if (column < 0 || column >= columns) return;
    const index = (rowBase + column) << 1;
    target[index] = charId;
    target[index + 1] = packed;
  }
}

function packDamage(first, end) {
  if (end <= first) return 0;
  return end * DAMAGE_END + first * DAMAGE_SPAN + end;
}

// ─── Installation ───────────────────────────────────────────

function install() {
  if (typeof Bun !== 'object' || Bun === null) return false;
  if (typeof Bun.ant === 'object' && Bun.ant !== null && typeof Bun.ant.CellSegmenter === 'function') return false;
  if (globalThis.__clawgodPatches && globalThis.__clawgodPatches['bun-ant-shim'] === false) return false;
  try {
    if (typeof Bun.ant !== 'object' || Bun.ant === null) Bun.ant = {};
    Bun.ant.CellSegmenter = CellSegmenter;
  } catch {
    return false;
  }
  return true;
}

module.exports = { CellSegmenter, install, packDamage, scanChunks };

if (install() && process.env.CLAWGOD_BUN_ANT_SHIM_DEBUG === '1') {
  // stderr only (stdout belongs to the TUI renderer), opt-in: the install log
  // already names the renderer runtime path on every (re)install.
  process.stderr.write('[clawgod] Bun.ant shim active (Claude Code >= 2.1.271 renderer on stock Bun)\n');
}
