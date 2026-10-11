import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

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

// Embedded text requires return strings in the native bundle. Bun's disk
// loader returns a module namespace, so read extracted text assets as UTF-8.
function fixTextRequires(c) {
  const textRoot = JSON.stringify(join(here, 'bunfs'));
  return c.replace(/\b([\w$]+)=import\.meta\.require(?=[,;])/g, (_match, name) =>
    `${name} = (id) => {
      if (/\\.(?:txt|md)$/.test(id)) {
        const fs = import.meta.require('node:fs');
        const path = import.meta.require('node:path');
        const relative = path.relative(fs.realpathSync(${textRoot}), fs.realpathSync(id));
        if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
          return fs.readFileSync(id, 'utf8');
        }
      }
      return import.meta.require(id);
    }`,
  );
}

if (isChunked) {
  // ── v2.1.245+ ESM chunk graph path ──
  const pathMap = JSON.parse(readFileSync(pathMapFile, 'utf8'));
  // build the replace table: /$bunfs/root/X → <here>/<relative-on-disk>
  const replaceTable = new Map();
  for (const [bunPath, rel] of Object.entries(pathMap)) {
    replaceTable.set(bunPath, join(here, rel));
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
  code = fixTextRequires(code);
  writeFileSync(dst, code);
  unlinkSync(src);

  // rewrite every chunk/asset file in bunfs/ in place
  const bunfsDir = join(here, 'bunfs');
  let n = 0;
  for (const f of readdirSync(bunfsDir)) {
    if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue;
    const fp = join(bunfsDir, f);
    let fc = readFileSync(fp, 'utf8');
    fc = stripPragma(fc);
    fc = rewriteGraph(fc);
    fc = fixFileURLs(fc);
    fc = fixTextRequires(fc);
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
