#!/usr/bin/env node
// Unit tests for src/shared/bun-ant-shim.cjs — the JS implementation of the
// Bun.ant.CellSegmenter API that Claude Code >= 2.1.271 renders through.
//
// Runs under plain Node (the shim's width lookup falls back when Bun is
// absent), so it needs no Bun and no Claude bundle. Run with:
//   node src/shared/bun-ant-shim.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { CellSegmenter, install, scanChunks } = require('./bun-ant-shim.cjs');

// Constants mirrored from the bundle (see the shim header).
const RUN_SHIFT = 10;
const TAB_FLAG = 256;
const WIDTH_MASK = 255;
const DAMAGE_SPAN = 1048576;
const DAMAGE_END = 68719476736;
const STYLE_SHIFT = 17;
const LINK_SHIFT = 2;
const LINK_MASK = 32767;

const OPTIONS = {
  ambiguousIsNarrow: true,
  substitute: [[1564, 1564]],
  screen: {
    widthMask: 3, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3,
    emptyCharIndex: 0, spacerCharIndex: 1, emptyWord: 0, tabWidth: 8,
  },
  tabWidth: 8,
};

const makeCells = (n = 512) => new Int32Array(n);
const makeRuns = (n = 512) => new Int32Array(n);

const cellWidth = (packed) => (packed & TAB_FLAG) !== 0 ? 'tab' : packed & WIDTH_MASK;
const cellRun = (packed) => packed >>> RUN_SHIFT;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ─── scanChunks ─────────────────────────────────────────────

test('scanChunks splits text, SGR and OSC-8 hyperlinks', () => {
  const chunks = scanChunks('a\x1b[1;31mb\x1b]8;;https://example.com\x07c\x1b]8;;\x07d');
  assert.deepEqual(chunks, [
    { kind: 'text', value: 'a' },
    { kind: 'sgr', value: '1;31' },
    { kind: 'text', value: 'b' },
    { kind: 'osc8', value: 'https://example.com' },
    { kind: 'text', value: 'c' },
    { kind: 'osc8', value: '' },
    { kind: 'text', value: 'd' },
  ]);
});

test('scanChunks drops non-SGR escapes and keeps text around them', () => {
  const chunks = scanChunks('x\x1b[2Ky\x1b]0;title\x07z');
  assert.deepEqual(chunks.map((c) => c.kind), ['text', 'text', 'text']);
  assert.equal(chunks.map((c) => c.value).join(''), 'xyz');
});

// ─── segment ────────────────────────────────────────────────

test('segment reports one cell per grapheme with plain widths', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const cells = makeCells();
  const runs = makeRuns();
  const count = segmenter.segment('abc', cells, runs, false);

  assert.equal(count, 3);
  assert.deepEqual(Array.from(cells.slice(0, 6)), [2, 1, 3, 1, 4, 1]); // grapheme ids, width 1
  assert.equal(runs[0], 0); // default style
  assert.equal(runs[1], 0); // no hyperlink
  assert.deepEqual(segmenter.graphemes, [' ', '', 'a', 'b', 'c']);
  assert.deepEqual(segmenter.sgrKeys, ['']);
});

test('segment measures wide, ambiguous and combining graphemes', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const cells = makeCells();
  segmenter.segment('日▐a\u0301', cells, makeRuns(), false);

  const widths = [cells[1], cells[3], cells[5]];
  assert.equal(widths[0] & WIDTH_MASK, 2, 'CJK is double width');
  assert.equal(widths[1] & WIDTH_MASK, 1, 'ambiguous width counts as narrow');
  assert.equal(widths[2] & WIDTH_MASK, 1, 'combining mark merges into the base grapheme');
  assert.deepEqual(segmenter.graphemes.slice(2), ['日', '▐', 'a\u0301']);
});

test('segment measures a ZWJ family emoji as one double-width cluster', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const cells = makeCells();
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
  segmenter.segment(family, cells, makeRuns(), false);
  assert.equal(cells[1] & WIDTH_MASK, 2, 'family emoji is one wide cluster, not eleven columns');
});

test('segment widths agree with Bun.stringWidth when it is available', () => {
  const bun = typeof globalThis.Bun === 'object' && globalThis.Bun !== null ? globalThis.Bun : undefined;
  if (!bun || typeof bun.stringWidth !== 'function') return; // Node CI exercises the fallback instead
  const segmenter = new CellSegmenter(OPTIONS);
  const cells = makeCells();
  const count = segmenter.segment('a日\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}', cells, makeRuns(), false);
  assert.equal(count, 3);
  const widths = [cells[1] & WIDTH_MASK, cells[3] & WIDTH_MASK, cells[5] & WIDTH_MASK];
  assert.deepEqual(widths, [1, 2, 2], 'a = 1, CJK = 2, family emoji = 2');
});

test('segment marks tab cells with the tab flag', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const cells = makeCells();
  const count = segmenter.segment('a\tb', cells, makeRuns(), false);

  assert.equal(count, 3);
  assert.equal(cells[1] & WIDTH_MASK, 1);
  assert.equal(cells[3] & TAB_FLAG, TAB_FLAG);
  assert.equal(cells[5] & WIDTH_MASK, 1);
});

test('segment assigns one style id per SGR run and dedupes repeats', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const cells = makeCells();
  const runs = makeRuns();
  // Balanced styling: the trailing \x1b[22m returns the SGR state to default,
  // so re-segmenting the same text reuses the same style ids.
  const text = 'a\x1b[7mb\x1b[27mc\x1b[1md\x1b[22m';
  const count = segmenter.segment(text, cells, runs, false);

  assert.equal(count, 4);
  assert.deepEqual(segmenter.sgrKeys, ['', '\x1b[7m', '\x1b[1m']);
  assert.deepEqual(segmenter.sgrCloseKeys, ['', '\x1b[27m', '\x1b[22m']);

  const styles = [];
  for (let i = 0; i < count; i++) styles.push(runs[cellRun(cells[i * 2 + 1]) * 2]);
  assert.deepEqual(styles, [0, 1, 0, 2]);

  segmenter.segment(text, makeCells(), makeRuns(), false);
  assert.equal(segmenter.sgrKeys.length, 3, 'repeated styling reuses the style table');
});

test('segment keeps SGR state across calls so wrapped spans stay styled', () => {
  const segmenter = new CellSegmenter(OPTIONS);

  // Line 1 opens dim without closing it; the renderer emits each screen line
  // as its own write op, so the continuation line must inherit the state.
  segmenter.segment('a\x1b[2m', makeCells(), makeRuns(), false);
  const runs = makeRuns();
  segmenter.segment('b', makeCells(), runs, false);

  assert.deepEqual(segmenter.sgrKeys, ['', '\x1b[2m']);
  assert.equal(runs[0], 1, 'second call keeps the active style');
});

test('segment splits combined and 256-colour SGR into single parameters', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  segmenter.segment('\x1b[1;31;48;5;17mX', makeCells(), makeRuns(), false);
  assert.deepEqual(segmenter.sgrKeys[1].split('\u0000'), ['\x1b[1m', '\x1b[31m', '\x1b[48;5;17m']);
  assert.deepEqual(segmenter.sgrCloseKeys[1].split('\u0000'), ['\x1b[22m', '\x1b[39m', '\x1b[49m']);

  const truecolor = new CellSegmenter(OPTIONS);
  truecolor.segment('\x1b[38;2;10;20;30mX', makeCells(), makeRuns(), false);
  assert.equal(truecolor.sgrKeys[1], '\x1b[38;2;10;20;30m');
  assert.equal(truecolor.sgrCloseKeys[1], '\x1b[39m');
});

test('segment tracks OSC-8 hyperlinks in runs', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const cells = makeCells();
  const runs = makeRuns();
  segmenter.segment('a\x1b]8;;https://a.test\x07bc\x1b]8;;\x07d', cells, runs, false);

  assert.deepEqual(segmenter.uris, ['', 'https://a.test']);
  assert.equal(runs[1], 0, 'leading text carries no link');
  assert.equal(runs[3], 1, 'linked run points at uris[1]');
  assert.equal(runs[5], 0, 'closing the link ends the run');
});

test('segment returns negative capacity when the output arrays are too small', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const cells = new Int32Array(4);
  const runs = new Int32Array(4);
  const count = segmenter.segment('abcdef', cells, runs, false);
  assert.equal(count, -6);

  const grown = new Int32Array(12);
  const count2 = segmenter.segment('abcdef', grown, new Int32Array(12), false);
  assert.equal(count2, 6);
});

test('segment rolls back SGR state when a capacity retry is needed', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const text = 'aaa\x1b[1mbbb';
  const tiny = new Int32Array(4);
  assert.equal(segmenter.segment(text, tiny, new Int32Array(4), false), -6, 'first pass overflows');

  // The bundle re-runs segment() on the same text with grown arrays. The
  // leading cells must stay in the default style — a leaked {bold} state from
  // the failed pass would mis-style "aaa".
  const cells = new Int32Array(16);
  const runs = new Int32Array(16);
  const count = segmenter.segment(text, cells, runs, false);
  assert.equal(count, 6);
  const styles = [];
  for (let i = 0; i < count; i++) styles.push(runs[cellRun(cells[i * 2 + 1]) * 2]);
  assert.deepEqual(styles, [0, 0, 0, 1, 1, 1]);
});

test('segment mutates its output tables in place', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const graphemes = segmenter.graphemes;
  const sgrKeys = segmenter.sgrKeys;
  segmenter.segment('abc', makeCells(), makeRuns(), false);
  segmenter.segment('\x1b[7mz\x1b[27m', makeCells(), makeRuns(), false);

  assert.equal(segmenter.graphemes, graphemes, 'graphemes array identity is stable');
  assert.equal(segmenter.sgrKeys, sgrKeys, 'sgrKeys array identity is stable');
  assert.deepEqual(graphemes.slice(0, 2), [' ', '']);
});

// The 2.1.274 renderer caches resolved styles by segmenter ID until it
// rebuilds the segmenter or invalidates the whole cache on a generation change.
function cachedStyle(segmenter, cache, id) {
  if (!cache.has(id)) {
    cache.set(id, [segmenter.sgrKeys[id].split('\u0000'), segmenter.sgrCloseKeys[id].split('\u0000')]);
  }
  return cache.get(id);
}

const colorCode = (i) => `\x1b[38;2;0;${i >>> 8};${i & 255}m`;

test('segment preserves caller-cached style IDs beyond 2048 styles', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const cache = new Map();
  const cells = makeCells();
  const runs = makeRuns();
  for (let i = 0; i < 2050; i++) {
    segmenter.segment(`${colorCode(i)}X\x1b[0m`, cells, runs, false);
    assert.deepEqual(cachedStyle(segmenter, cache, runs[0]), [[colorCode(i)], ['\x1b[39m']], `style ${i}`);
  }
  segmenter.segment(`${colorCode(0)}X\x1b[0m`, cells, runs, false);
  assert.deepEqual(cachedStyle(segmenter, cache, runs[0]), [[colorCode(0)], ['\x1b[39m']]);
  assert.equal(segmenter.sgrKeys.length, 2051, 'old IDs remain valid and reusable');
});

test('segment retains every style in a long multicolour line across capacity retry', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const count = 2048;
  const text = Array.from({ length: count }, (_, i) => `${colorCode(i)}X`).join('') + '\x1b[0m';
  assert.equal(segmenter.segment(text, makeCells(), makeRuns(), false), -count);
  const cells = makeCells(count * 2);
  const runs = makeRuns(count * 2);
  assert.equal(segmenter.segment(text, cells, runs, false), count);
  const cache = new Map();
  for (let i = 0; i < count; i++) {
    const styleId = runs[cellRun(cells[i * 2 + 1]) * 2];
    assert.deepEqual(cachedStyle(segmenter, cache, styleId), [[colorCode(i)], ['\x1b[39m']], `cell ${i}`);
  }
});

// ─── paint / setCell ────────────────────────────────────────

function paintLine(segmenter, text, x, y, columns = 20) {
  const lineCells = makeCells();
  const runs = makeRuns();
  const count = segmenter.segment(text, lineCells, runs, false);
  const charMap = new Int32Array(segmenter.graphemes.length);
  for (let i = 0; i < segmenter.graphemes.length; i++) charMap[i] = 100 + i;
  const words = new Int32Array(16);
  for (let i = 0; i < 16; i++) words[i] = runs[i * 2] << STYLE_SHIFT;
  const screen = new Int32Array(columns * 4 * 2);
  const damage = segmenter.paint(screen, columns, x, y, lineCells, count, undefined, charMap, words);
  return { screen, damage, count, columns };
}

const glyphAt = (screen, columns, x, y) => screen[((y * columns + x) << 1)];

test('paint writes narrow glyphs and reports the damaged span', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const { screen, damage, count, columns } = paintLine(segmenter, 'abc', 2, 1);
  assert.equal(count, 3);
  assert.equal(glyphAt(screen, columns, 2, 1), 102);
  assert.equal(glyphAt(screen, columns, 4, 1), 104);
  assert.equal(screen[((1 * columns + 2) << 1) + 1] & 3, 0, 'narrow cell keeps kind 0');
  assert.equal(Math.floor(damage / DAMAGE_SPAN) % 65536, 2, 'damage starts at x');
  assert.equal(Math.floor(damage / DAMAGE_END), 5, 'damage ends after the last column');
  assert.equal(damage % DAMAGE_SPAN, 5, 'low field is the ending column, not the span');
});

test('paint returns an absolute ending column for indented soft wraps', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const start = 5;
  const { damage } = paintLine(segmenter, 'abc', start, 0);
  // The 2.1.274 layout consumes paint's low field as xC()'s return value,
  // then packs it into the next row's softWrap entry via Qf(end, start).
  const end = damage % DAMAGE_SPAN;
  const softWrap = (end << 16) | start;
  assert.equal(softWrap >>> 16, 8, 'previous row ends at column 8');
  assert.equal(softWrap & 32767, 5, 'continuation starts at column 5');
  assert.equal((softWrap >>> 16) - start, 3, 'selection retains all three columns');
});

test('paint emits a spacer cell for double-width glyphs', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const { screen, columns } = paintLine(segmenter, '日x', 0, 0);
  assert.equal(glyphAt(screen, columns, 0, 0), 102, 'wide glyph cell');
  assert.equal(screen[1] & 3, 1, 'wide kind');
  assert.equal(glyphAt(screen, columns, 1, 0), 101, 'spacer carries charMap[spacerCharIndex]');
  assert.equal(screen[3] & 3, 2, 'spacerTail kind');
  assert.equal(glyphAt(screen, columns, 2, 0), 103, 'following glyph shifts right');
});

test('paint decodes the hyperlink id from the words field', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const lineCells = makeCells();
  const runs = makeRuns();
  const count = segmenter.segment('ab', lineCells, runs, false);
  const charMap = new Int32Array(segmenter.graphemes.length);
  for (let i = 0; i < segmenter.graphemes.length; i++) charMap[i] = 100 + i;

  // runWords() caches poolId + 1 internally, but subtracts that sentinel
  // offset before packing words. The word already contains the actual pool ID.
  const poolId = 7;
  const words = new Int32Array(4);
  words[0] = (runs[0] << STYLE_SHIFT) | (poolId << LINK_SHIFT);
  const screen = new Int32Array(40);
  segmenter.paint(screen, 20, 0, 0, lineCells, count, undefined, charMap, words);
  assert.equal((screen[1] >>> LINK_SHIFT) & LINK_MASK, poolId, 'screen stores the pool id');

  const words0 = new Int32Array(4);
  words0[0] = runs[0] << STYLE_SHIFT;
  const screen0 = new Int32Array(40);
  segmenter.paint(screen0, 20, 0, 0, lineCells, count, undefined, charMap, words0);
  assert.equal((screen0[1] >>> LINK_SHIFT) & LINK_MASK, 0, 'zero link field stays zero');
});

test('paint preserves the first and subsequent OSC-8 hyperlink targets', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const cells = makeCells();
  const runs = makeRuns();
  const count = segmenter.segment('\x1b[1m\x1b]8;;https://a.test\x07A\x1b]8;;https://b.test\x07B\x1b]8;;\x07C\x1b[0m', cells, runs, false);
  const pool = ['', 'https://a.test', 'https://b.test'];
  const charMap = Int32Array.from(segmenter.graphemes, (_, i) => i);
  const words = new Int32Array(count);
  const linkIds = new Map();
  for (let run = 0; run < count; run++) {
    const uriId = runs[run * 2 + 1];
    let poolId = 0;
    if (uriId !== 0) {
      // Model the caller's cache sentinel and conversion to a packed word.
      if (!linkIds.has(uriId)) linkIds.set(uriId, pool.indexOf(segmenter.uris[uriId]) + 1);
      poolId = linkIds.get(uriId) - 1;
    }
    words[run] = (7 << STYLE_SHIFT) | (poolId << LINK_SHIFT);
  }
  const screen = new Int32Array(count * 2);
  segmenter.paint(screen, count, 0, 0, cells, count, undefined, charMap, words);
  const targets = Array.from({ length: count }, (_, i) => pool[(screen[i * 2 + 1] >>> LINK_SHIFT) & LINK_MASK]);
  assert.deepEqual(targets, ['https://a.test', 'https://b.test', '']);
  for (let i = 0; i < count; i++) assert.equal(screen[i * 2 + 1] >>> STYLE_SHIFT, 7, 'style bits survive');
});

test('paint expands tabs to the next tab stop', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const { screen, columns } = paintLine(segmenter, 'a\tb', 0, 0);
  assert.equal(glyphAt(screen, columns, 0, 0), 102);
  for (let x = 1; x < 8; x++) assert.equal(glyphAt(screen, columns, x, 0), 100, `blank at ${x}`);
  assert.equal(glyphAt(screen, columns, 8, 0), 104, 'text resumes at the tab stop');
});

test('paint clips writes to the target width and stays damage-free when empty', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const narrow = paintLine(segmenter, 'abcdef', 2, 0, 4);
  assert.equal(narrow.damage % DAMAGE_SPAN, 8, 'low field keeps the intended ending column');

  const lineCells = makeCells();
  const count = segmenter.segment('\u0301', lineCells, makeRuns(), false);
  assert.equal(count, 1);
  assert.equal(lineCells[1] & WIDTH_MASK, 0, 'combining-only grapheme occupies no column');
  const screen = new Int32Array(40);
  const damage = segmenter.paint(screen, 20, 0, 0, lineCells, count, undefined, new Int32Array(4), new Int32Array(4));
  assert.equal(damage, 0);
  assert.equal(screen[0], 0);
});

test('setCell writes a single cell and reports a one-column damage rect', () => {
  const segmenter = new CellSegmenter(OPTIONS);
  const screen = new Int32Array(40);
  const packed = (5 << STYLE_SHIFT) | 1;
  const damage = segmenter.setCell(screen, 10, 3, 1, 77, packed);

  assert.equal(screen[((1 * 10 + 3) << 1)], 77);
  assert.equal(screen[((1 * 10 + 3) << 1) + 1], packed);
  assert.equal(Math.floor(damage / DAMAGE_SPAN) % 65536, 3);
  assert.equal(Math.floor(damage / DAMAGE_END), 4);
  assert.equal(damage % DAMAGE_SPAN, 4);
  assert.equal(segmenter.setCell(screen, 10, 42, 0, 1, 1), 0, 'out-of-range writes report nothing');
});

// ─── install ────────────────────────────────────────────────

// Bun's global Bun binding is read-only, so tests stub a writable namespace
// only when the real one is missing (plain Node).
function targetBun() {
  if (typeof globalThis.Bun === 'object' && globalThis.Bun !== null) return globalThis.Bun;
  Object.defineProperty(globalThis, 'Bun', { value: {}, configurable: true, writable: true });
  return globalThis.Bun;
}

test('install fills in a missing Bun.ant namespace', () => {
  const bun = targetBun();
  const saved = bun.ant;
  try {
    delete bun.ant;
    assert.equal(install(), true);
    assert.equal(typeof bun.ant.CellSegmenter, 'function');
    assert.equal(install(), false, 'second call is a no-op');
  } finally {
    if (saved === undefined) delete bun.ant; else bun.ant = saved;
  }
});

test('install never shadows a native CellSegmenter', () => {
  const bun = targetBun();
  const saved = bun.ant;
  const native = function NativeCellSegmenter() {};
  try {
    bun.ant = { CellSegmenter: native };
    assert.equal(install(), false);
    assert.equal(bun.ant.CellSegmenter, native);
  } finally {
    if (saved === undefined) delete bun.ant; else bun.ant = saved;
  }
});

test('install respects the bun-ant-shim feature toggle', () => {
  const bun = targetBun();
  const saved = bun.ant;
  try {
    delete bun.ant;
    globalThis.__clawgodPatches = { 'bun-ant-shim': false };
    assert.equal(install(), false);
    assert.equal(bun.ant, undefined, 'disabled shim installs nothing');
  } finally {
    delete globalThis.__clawgodPatches;
    if (saved === undefined) delete bun.ant; else bun.ant = saved;
  }
});

// ─── runner ─────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message.split('\n').join('\n       ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
