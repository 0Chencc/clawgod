#!/usr/bin/env node

const {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');

const ROOT = __dirname;
const SOURCE_ROOT = join(ROOT, 'src');
const PLACEHOLDER_RE = /{{CLAWGOD:[^}]+}}/g;

const identity = (content) => content;

// Windows PowerShell 5.1 treats UTF-8 without a BOM as the active ANSI code
// page, while `irm ... | iex` exposes a UTF-8 BOM as a literal U+FEFF token.
// Keep the generated installer ASCII-only and encode Unicode in embedded
// JavaScript/JSON as UTF-16 escape sequences, which both grammars understand.
const escapeNonAscii = (content) => content.replace(
  /[^\x00-\x7F]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
);

// PowerShell's single-quoted here-string cannot safely embed the annotated
// proxy source used by install.sh. The existing Windows artifact intentionally
// omits its header comments and blank separator lines; derive that compact form
// from the shared implementation instead of maintaining a second proxy.
const compactProxyForPowerShell = (content) => content
  .split('\n')
  .filter((line) => line !== '')
  .filter((line) => !line.startsWith('// Anthropic Messages API'))
  .filter((line) => !line.startsWith('// Allows Claude Code'))
  .join('\n');

const compactAndEscapeProxyForPowerShell = (content) => escapeNonAscii(
  compactProxyForPowerShell(content),
);

const TARGETS = [
  {
    name: 'install.sh',
    template: 'templates/install.sh',
    mode: 0o755,
    sources: {
      'extract-natives.mjs': ['shared/extract-natives.mjs', identity],
      'post-process.mjs': ['shared/post-process.mjs', identity],
      'repatch.mjs': ['shared/repatch.mjs', identity],
      'openai-proxy.cjs': ['shared/openai-proxy.cjs', identity],
      'cli.cjs': ['unix/cli.cjs', identity],
      'patch.mjs': ['shared/patch.mjs', identity],
      'features.json': ['shared/features.json', identity],
    },
  },
  {
    name: 'install.ps1',
    template: 'templates/install.ps1',
    asciiOnly: true,
    sources: {
      'npm-fetch.mjs': ['windows/npm-fetch.mjs', escapeNonAscii],
      'extract-natives.mjs': ['shared/extract-natives.mjs', escapeNonAscii],
      'post-process.mjs': ['shared/post-process.mjs', escapeNonAscii],
      'repatch.mjs': ['shared/repatch.mjs', escapeNonAscii],
      'openai-proxy.cjs': ['shared/openai-proxy.cjs', compactAndEscapeProxyForPowerShell],
      'cli.cjs': ['windows/cli.cjs', escapeNonAscii],
      'patch.mjs': ['shared/patch.mjs', escapeNonAscii],
      'features.json': ['shared/features.json', escapeNonAscii],
      'lean-remove.cjs': ['windows/lean-remove.cjs', escapeNonAscii],
      'lean-apply.cjs': ['windows/lean-apply.cjs', escapeNonAscii],
    },
  },
];

function readSource(relativePath) {
  const path = join(SOURCE_ROOT, relativePath);
  if (!existsSync(path)) throw new Error(`Missing build source: ${relativePath}`);
  const content = readFileSync(path, 'utf8');
  if (!content.endsWith('\n')) {
    throw new Error(`Build source must end with a newline: ${relativePath}`);
  }
  return content.slice(0, -1);
}

function render(target) {
  const templatePath = join(SOURCE_ROOT, target.template);
  if (!existsSync(templatePath)) throw new Error(`Missing template: ${target.template}`);
  let output = readFileSync(templatePath, 'utf8').replace(/^\uFEFF/, '');

  for (const [name, [sourcePath, transform]] of Object.entries(target.sources)) {
    const placeholder = `{{CLAWGOD:${name}}}`;
    const matches = output.split(placeholder).length - 1;
    if (matches !== 1) {
      throw new Error(`${target.template}: expected one ${placeholder}, found ${matches}`);
    }
    const source = transform(readSource(sourcePath));
    output = output.replace(placeholder, () => source);
  }

  const unresolved = output.match(PLACEHOLDER_RE);
  if (unresolved) {
    throw new Error(`${target.template}: unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);
  }
  if (target.asciiOnly) {
    const nonAsciiIndex = output.search(/[^\x00-\x7F]/);
    if (nonAsciiIndex !== -1) {
      const codePoint = output.codePointAt(nonAsciiIndex).toString(16).toUpperCase();
      throw new Error(`${target.template}: non-ASCII U+${codePoint} at character ${nonAsciiIndex}`);
    }
  }
  return output;
}

function firstDifference(actual, expected) {
  const length = Math.min(actual.length, expected.length);
  for (let index = 0; index < length; index++) {
    if (actual[index] !== expected[index]) return index;
  }
  return actual.length === expected.length ? -1 : length;
}

function checkTarget(target, expected) {
  const outputPath = join(ROOT, target.name);
  if (!existsSync(outputPath)) {
    console.error(`out of date: ${target.name} is missing`);
    return false;
  }
  const actual = readFileSync(outputPath, 'utf8');
  if (actual === expected) {
    console.log(`ok: ${target.name}`);
    return true;
  }
  const offset = firstDifference(actual, expected);
  console.error(`out of date: ${target.name} (first difference at character ${offset})`);
  return false;
}

function main() {
  const check = process.argv.includes('--check');
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}`);
    process.exit(2);
  }

  let success = true;
  for (const target of TARGETS) {
    const content = render(target);
    if (check) {
      success = checkTarget(target, content) && success;
      continue;
    }
    const outputPath = join(ROOT, target.name);
    writeFileSync(outputPath, content, 'utf8');
    if (target.mode) chmodSync(outputPath, target.mode);
    console.log(`built: ${target.name} (${Buffer.byteLength(content)} bytes)`);
  }
  if (!success) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
