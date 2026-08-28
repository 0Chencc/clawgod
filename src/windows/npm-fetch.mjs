// Download a scoped npm tarball (no npm CLI dependency) and extract it
// using Node's built-in zlib + a minimal POSIX tar parser.
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { URL } from 'node:url';

const [, , pkgSpec, outDir] = process.argv;
const last = pkgSpec.lastIndexOf('@');
const pkg = last > 0 ? pkgSpec.slice(0, last) : pkgSpec;
const ver = last > 0 ? pkgSpec.slice(last + 1) : 'latest';

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error(`Too many redirects`));
    const parsed = new URL(url);
    const reqMod = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const opts = { method: 'GET', hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.pathname + parsed.search };
    reqMod(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).end();
  });
}

const metaBuf = await get(`https://registry.npmjs.org/${pkg}/${ver}`);
const meta = JSON.parse(metaBuf.toString('utf8'));
console.log(`Resolved ${pkg}@${meta.version}`);
const tgz = await get(meta.dist.tarball);
console.log(`Downloaded ${(tgz.length / 1024 / 1024).toFixed(1)} MB`);

const buf = gunzipSync(tgz);
mkdirSync(outDir, { recursive: true });
let off = 0, files = 0;
while (off + 512 <= buf.length) {
  const name = buf.slice(off, off + 100).toString('utf8').replace(/\0+$/, '');
  if (!name) break;
  const sizeOct = buf.slice(off + 124, off + 136).toString('utf8').replace(/[\0\s]+$/, '');
  const size = parseInt(sizeOct, 8) || 0;
  const typeflag = String.fromCharCode(buf[off + 156]);
  off += 512;
  if (typeflag === '0' || typeflag === '\0') {
    const dest = join(outDir, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf.slice(off, off + size));
    files++;
  }
  off += Math.ceil(size / 512) * 512;
}
console.log(`Extracted ${files} files`);
console.log(`VERSION=${meta.version}`);
