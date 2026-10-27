import { readFileSync, writeFileSync, unlinkSync, existsSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from './acorn.mjs';

// Generate paths in the OS's canonical form, including Windows 8.3 aliases.
const here = realpathSync.native(dirname(fileURLToPath(import.meta.url)));
const src = `${here}/cli.original.js`;
const dst = `${here}/cli.original.cjs`;
const pathMapFile = `${here}/pathmap.json`;

let code = readFileSync(src, 'utf8');

// v2.1.245+ splits the app into an ESM chunk graph; post-process then
// rewrites the whole bunfs/ dir too. Legacy single-bundle has no pathmap.
const isChunked = existsSync(pathMapFile);

// (0) Strip leading @bun pragma comments (e.g. "// @bun @bytecode @bun-cjs\n")
// Bun requires the file to start directly with "(function" (CJS) or the
// first import (ESM) — any preceding comment breaks that detection.
function stripPragma(c) { return c.replace(/^(?:\/\/[^\n]*\n)+/, ''); }

// build-time fileURLToPath() leaks → use cli.cjs's own __filename
function fixFileURLs(c) {
  return c.replace(
    /[\w$]+\.fileURLToPath\("file:\/\/\/home\/runner\/work\/claude-cli-internal\/claude-cli-internal\/[^"]*"\)/g,
    () => '__filename',
  );
}

// The native bundle retains loader semantics even for executable extensions.
// Disk require must never execute an embedded text/file asset (#233).
function fixAssetRequires(c, assets) {
  if (!c.includes('require')) return c;
  const loader = `(() => {
    const fs = import.meta.require('node:fs');
    const path = import.meta.require('node:path');
    const types = new Map(${JSON.stringify([...assets])});
    return (id) => {
      if (typeof id === 'string' && path.isAbsolute(id) && fs.existsSync(id)) {
        const canonical = fs.realpathSync.native(id);
        const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
        const type = types.get(key);
        if (type === 'text') return fs.readFileSync(id, 'utf8');
        if (type === 'file') return id;
      }
      return import.meta.require(id);
    };
  })()`;
  const isRequire = node => node?.type === 'MemberExpression' &&
    (node.computed ? node.property.value === 'require' : node.property.name === 'require') &&
    node.object.type === 'MetaProperty' && node.object.meta.name === 'import';
  const pending = [parse(c, { ecmaVersion: 'latest', sourceType: 'module' })];
  const edits = [];
  while (pending.length) {
    const node = pending.pop();
    const alias = node.type === 'VariableDeclarator' ? node.init
      : node.type === 'AssignmentExpression' && node.operator === '=' ? node.right : null;
    if (isRequire(alias)) edits.push(alias);
    if (node.type === 'CallExpression' && isRequire(node.callee)) {
      const id = node.arguments[0]?.value;
      const key = typeof id === 'string' && process.platform === 'win32' ? id.toLowerCase() : id;
      if (assets.has(key)) edits.push(node.callee);
    }
    for (const value of Object.values(node)) {
      if (value?.type) pending.push(value);
      else if (Array.isArray(value)) pending.push(...value.filter(child => child?.type));
    }
  }
  for (const node of edits.sort((a, b) => b.start - a.start)) {
    c = c.slice(0, node.start) + loader + c.slice(node.end);
  }
  return c;
}

if (isChunked) {
  // ── v2.1.245+ ESM chunk graph path ──
  const pathMap = JSON.parse(readFileSync(pathMapFile, 'utf8'));
  // build the replace table: /$bunfs/root/X → <here>/<relative-on-disk>
  const replaceTable = new Map();
  const assets = new Map();
  const graphFiles = new Set();
  for (const [bunPath, { path, loader }] of Object.entries(pathMap)) {
    const target = join(here, path);
    replaceTable.set(bunPath, target);
    if (loader === 'text' || loader === 'file') {
      const canonical = realpathSync.native(target);
      assets.set(process.platform === 'win32' ? canonical.toLowerCase() : canonical, loader);
    }
    if (['js', 'jsx', 'ts', 'tsx'].includes(loader) && path.startsWith('bunfs/')) {
      graphFiles.add(target);
    }
  }

  function rewriteGraph(text) {
    // Replace string literals containing the virtual in-bundle root
    // (POSIX "/$bunfs/root/..." or Windows single-drive "B:/~BUN/root/...")
    // with the on-disk absolute path from the replace table.
    return text.replace(/["'`](?:\/\$bunfs\/root|[A-Za-z]:\/~BUN\/root)\/[^"'`]+["'`]/g, (m) => {
      const body = m.slice(1, -1);
      const target = replaceTable.get(body) || replaceTable.get(body.replaceAll('\\','/'));
      // JSON.stringify emits a valid JS string literal. This is essential on
      // Windows, where path.join() returns backslashes that would otherwise be
      // interpreted as escapes (for example, \b in "\bunfs").
      return target ? JSON.stringify(target) : m;
    });
  }

  // entry → cli.original.cjs (ESM, no IIFE wrap)
  code = stripPragma(code);
  code = rewriteGraph(code);
  code = fixFileURLs(code);
  code = fixAssetRequires(code, assets);
  writeFileSync(dst, code);
  unlinkSync(src);

  // Rewrite code chunks only; skill templates must stay byte-for-byte intact.
  let n = 0;
  for (const fp of graphFiles) {
    let fc = readFileSync(fp, 'utf8');
    fc = stripPragma(fc);
    fc = rewriteGraph(fc);
    fc = fixFileURLs(fc);
    fc = fixAssetRequires(fc, assets);
    writeFileSync(fp, fc);
    n++;
  }
  console.log(`cli.original.cjs: ${code.length} bytes (chunked, rewrote ${n} graph files)`);
} else {
  // ── Legacy single-bundle path ──
  code = stripPragma(code);

  // (1) bunfs .node module paths → runtime vendor lookup
  code = code.replace(
    /require\(['"](\/\$bunfs\/root\/([\w-]+)\.node)['"]\)/g,
    (m, _full, name) =>
      `require(require('path').join(__dirname,'vendor',${JSON.stringify(name)},\`\${process.arch==='arm64'?'arm64':'x64'}-\${process.platform==='darwin'?'darwin':process.platform==='linux'?'linux':'win32'}\`,${JSON.stringify(name + '.node')}))`,
  );

  code = fixFileURLs(code);

  // (3) make the outer (function(...){...}) actually run
  code = code.replace(/\}\)\s*$/, '})(exports, require, module, __filename, __dirname)');

  writeFileSync(dst, code);
  unlinkSync(src);
  console.log(`cli.original.cjs: ${code.length} bytes`);
}
