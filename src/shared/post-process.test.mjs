import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'clawgod text assets-'));
const bun = process.env.CLAWGOD_TEST_BUN || 'bun';
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
};

// Minimal PE/Bun fixture exercises the extractor's loader records end to end.
function extractFixture(dir, mount, pathMap) {
  const modules = [
    { name: mount + 'cli', loader: 'js', content: readFileSync(join(dir, 'cli.original.js')) },
    ...Object.entries(pathMap).map(([name, { path, loader }]) => ({
      name, loader, content: readFileSync(join(dir, path)),
    })),
  ];
  const parts = [];
  let offset = 0;
  const records = modules.map(({ name, content, loader }) => {
    const record = Buffer.alloc(52);
    const nameBytes = Buffer.from(name + '\0');
    record.writeUInt32LE(offset, 0);
    record.writeUInt32LE(nameBytes.length, 4);
    record.writeUInt32LE(offset + nameBytes.length, 8);
    record.writeUInt32LE(content.length, 12);
    record.writeUInt8({ js: 1, file: 5, text: 13 }[loader], 49);
    parts.push(nameBytes, content);
    offset += nameBytes.length + content.length;
    return record;
  });
  const offsets = Buffer.alloc(32);
  offsets.writeUInt32LE(offset, 8);
  offsets.writeUInt32LE(records.length * 52, 12);
  const payload = Buffer.concat([...parts, ...records, offsets, Buffer.from('\n---- Bun! ----\n')]);
  const header = Buffer.alloc(0x108);
  header.write('MZ');
  header.writeUInt32LE(0x40, 0x3c);
  header.write('PE\0\0', 0x40);
  header.writeUInt16LE(0x8664, 0x44);
  header.writeUInt16LE(1, 0x46);
  header.writeUInt16LE(2, 0x54);
  header.writeUInt16LE(0x20b, 0x58);
  header.write('.bun', 0x5a);
  header.writeUInt32LE(payload.length + 8, 0x6a);
  header.writeUInt32LE(0x100, 0x6e);
  header.writeBigUInt64LE(BigInt(payload.length), 0x100);
  const binary = join(dir, 'fixture.exe');
  writeFileSync(binary, Buffer.concat([header, payload]));
  run(process.execPath, [fileURLToPath(new URL('./extract-natives.mjs', import.meta.url)), binary, dir]);
  const extractedMap = JSON.parse(readFileSync(join(dir, 'pathmap.json'), 'utf8'));
  assert.deepEqual(extractedMap, { [mount + 'cli']: { path: 'cli.original.cjs', loader: 'js' }, ...pathMap });
}

try {
  for (const mount of ['/$bunfs/root/', 'B:/~BUN/root/']) {
    const dir = join(root, mount.startsWith('B:') ? 'windows' : 'posix', 'profile space \u6d4b\u8bd5');
    mkdirSync(join(dir, 'bunfs'), { recursive: true });
    for (const file of ['post-process.mjs', 'acorn.mjs']) {
      copyFileSync(new URL(file, import.meta.url), join(dir, file));
    }
    const pathMap = {
      [`${mount}helper.js`]: { path: 'bunfs/helper.js', loader: 'js' },
      [`${mount}state-library.js.txt`]: { path: 'bunfs/state-library.js.txt', loader: 'text' },
      [`${mount}guide.md`]: { path: 'bunfs/guide.md', loader: 'text' },
      [`${mount}module.mjs`]: { path: 'bunfs/module.mjs', loader: 'js' },
    };
    const templates = {};
    for (const ext of ['mjs', 'js', 'cjs', 'ts', 'tsx', 'jsx', 'md', 'txt', 'json', '']) {
      const name = `runner${ext ? '.' + ext : ''}`;
      templates[name] = `#!/usr/bin/env node\n// @bun\nvar require=import.meta.require;const asset=${JSON.stringify(mount + 'guide.md')};process.exit(2);\n`;
      pathMap[mount + name] = { path: 'bunfs/' + name, loader: 'text' };
      writeFileSync(join(dir, 'bunfs', name), templates[name]);
    }
    templates['file.mjs'] = '// @bun\nprocess.exit(3);\n';
    pathMap[mount + 'file.mjs'] = { path: 'bunfs/file.mjs', loader: 'file' };
    writeFileSync(join(dir, 'bunfs/file.mjs'), templates['file.mjs']);
    writeFileSync(join(dir, 'cli.original.js'),
      `import{load}from ${JSON.stringify(mount + 'helper.js')};var entryLoad=import.meta.require;export{load,entryLoad};`);
    writeFileSync(join(dir, 'bunfs/helper.js'),
      `var load = import.meta.require;let assigned;assigned = import.meta['require'];
const embeddedSource=()=>load(${JSON.stringify(mount + 'state-library.js.txt')});
const runner=load(${JSON.stringify(mount + 'runner.mjs')});
const file=import.meta.require(${JSON.stringify(mount + 'file.mjs')});
export{load,assigned,embeddedSource,runner,file};`);
    writeFileSync(join(dir, 'bunfs/state-library.js.txt'), 'export const answer = 42;\n');
    writeFileSync(join(dir, 'bunfs/guide.md'), '# Guide\n');
    writeFileSync(join(dir, 'bunfs/module.mjs'), 'export const value = 7;');
    writeFileSync(join(dir, 'external.txt'), 'outside the extracted graph');

    extractFixture(dir, mount, pathMap);
    run(process.execPath, [join(dir, 'post-process.mjs')]);
    const check = join(dir, 'check.mjs');
    writeFileSync(check, `
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SourceTextModule } from 'node:vm';
import { load, entryLoad } from './cli.original.cjs';
import { assigned, embeddedSource, runner, file } from './bunfs/helper.js';
assert.equal(runner, ${JSON.stringify(templates['runner.mjs'])});
assert.equal(file, join(import.meta.dirname, 'bunfs/file.mjs'));
const templates = ${JSON.stringify(templates)};
assert.equal(embeddedSource(), 'export const answer = 42;\\n');
const assetIds = [
  join(import.meta.dirname, 'bunfs/state-library.js.txt'),
  ${JSON.stringify(join(realpathSync.native(dir), 'bunfs/state-library.js.txt'))},
];
if (process.platform === 'win32') {
  assetIds.push(...assetIds.flatMap(id => [id.replaceAll(${JSON.stringify('\\')}, '/'), id.toLowerCase()]));
}
for (const requireAsset of [load, entryLoad, assigned]) {
  for (const [name, source] of Object.entries(templates)) {
    const id = join(import.meta.dirname, 'bunfs', name);
    assert.equal(requireAsset(id), name === 'file.mjs' ? id : source);
  }
  for (const id of new Set(assetIds)) {
    const source = requireAsset(id);
    assert.equal(typeof source, 'string', JSON.stringify({ id, loader: requireAsset.toString() }));
    const module = new SourceTextModule(source);
    await module.link(() => { throw new Error('Unexpected dependency'); });
    await module.evaluate();
    assert.equal(module.namespace.answer, 42);
  }
  assert.equal(requireAsset(join(import.meta.dirname, 'bunfs/guide.md')), '# Guide\\n');
  assert.equal(requireAsset(join(import.meta.dirname, 'bunfs/module.mjs')).value, 7);
  assert.equal(typeof requireAsset('node:fs').readFileSync, 'function');
  assert.equal(requireAsset(join(import.meta.dirname, 'external.txt')).default, 'outside the extracted graph');
  assert.throws(() => requireAsset(join(import.meta.dirname, 'bunfs/missing.txt')), /Cannot find module/);
}
`);
    run(bun, [check, '--resume', 'x']);
    for (const [name, source] of Object.entries(templates)) {
      assert.equal(readFileSync(join(dir, 'bunfs', name), 'utf8'), source, 'assets must remain unchanged');
    }

    const helper = readFileSync(join(dir, 'bunfs/helper.js'), 'utf8');
    copyFileSync(join(dir, 'cli.original.cjs'), join(dir, 'cli.original.js'));
    run(process.execPath, [join(dir, 'post-process.mjs')]);
    assert.equal(readFileSync(join(dir, 'bunfs/helper.js'), 'utf8'), helper, 'reprocessing must not nest loaders');
    run(bun, [check, '--resume', 'x']);
  }
  console.log('[post-process.test] text/file loaders preserve templates without executing them; module imports and errors are preserved');
} finally {
  rmSync(root, { recursive: true, force: true });
}
