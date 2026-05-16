import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const src = `${here}/cli.original.js`;
const dst = `${here}/cli.original.cjs`;

let code = readFileSync(src, 'utf8');

// (1) bunfs .node module paths → runtime vendor lookup
// WRAP IN TRY/CATCH: vendor/ may be empty (as of v2.1.142 no embedded .node
// modules are found), so require() throws MODULE_NOT_FOUND and crashes.
// The IIFE returns null on failure, preserving functionality for features
// whose native modules are missing while not crashing the whole process.
code = code.replace(
  /require\(['"](\/\$bunfs\/root\/([\w-]+)\.node)['"]\)/g,
  (m, _full, name) => {
    const resolved = `require('path').join(__dirname,'vendor',${JSON.stringify(name)},\`\${process.arch==='arm64'?'arm64':'x64'}-\${process.platform==='darwin'?'darwin':process.platform==='linux'?'linux':'win32'}\`,${JSON.stringify(name + '.node')})`;
    return `((()=>{try{return require(${resolved})}catch(e){return null}})())`;
  },
);

// (2) build-time fileURLToPath() leaks → use cli.cjs's own __filename
code = code.replace(
  /[\w$]+\.fileURLToPath\("file:\/\/\/home\/runner\/work\/claude-cli-internal\/claude-cli-internal\/[^"]*"\)/g,
  () => '__filename',
);

// (3) make the outer (function(...){...}) actually run
code = code.replace(/\}\)\s*$/, '})(exports, require, module, __filename, __dirname)');

writeFileSync(dst, code);
unlinkSync(src);
console.log(`cli.original.cjs: ${code.length} bytes`);
