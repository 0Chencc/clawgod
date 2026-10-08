import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'clawgod-source-backup-'));
const command = '.command("update").alias("upgrade").description("Update").action(s(async(A)=>{original()}))';
const colors = 'const color="rgb(215,119,87)";';
try {
  for (const graph of [false, true]) {
    const dir = join(root, graph ? 'graph' : 'legacy');
    mkdirSync(dir);
    copyFileSync(new URL('./patch.mjs', import.meta.url), join(dir, 'patch.mjs'));
    const entry = join(dir, 'cli.original.cjs');
    if (graph) mkdirSync(join(dir, 'bunfs'));
    const target = graph ? join(dir, 'bunfs/commands.js') : entry;
    const snapshot = join(dir, 'source-backup.json');
    const writeSource = (version, body = command) => {
      writeFileSync(entry, `// Version: ${version}\n${graph ? '// entry' : body + colors}`);
      if (graph) {
        writeFileSync(target, body);
        writeFileSync(join(dir, 'bunfs/colors.mjs'), colors);
        writeFileSync(join(dir, 'bunfs/asset.txt'), 'unchanged asset');
      }
    };
    const run = (...args) => spawnSync(process.execPath, [join(dir, 'patch.mjs'), ...args], { encoding: 'utf8' });
    const succeeds = (...args) => {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return result.stdout;
    };

    writeSource('2.1.283');
    const clean = readFileSync(target, 'utf8');
    succeeds('--capture-clean-source');
    const backup = readFileSync(snapshot, 'utf8');
    const first = succeeds();
    const patched = readFileSync(target, 'utf8');
    assert.match(patched, /clawgod self-update/);
    assert.notEqual(patched, clean);
    for (let attempt = 0; attempt < 3; attempt++) {
      const output = succeeds();
      assert.equal(output.match(/Result: .*/)[0], first.match(/Result: .*/)[0]);
      assert.equal(readFileSync(target, 'utf8'), patched, 'no nested or duplicate patches');
      assert.equal(readFileSync(snapshot, 'utf8'), backup, 'clean backup stays clean');
    }
    succeeds('--revert');
    assert.equal(readFileSync(target, 'utf8'), clean);
    if (graph) assert.equal(readFileSync(join(dir, 'bunfs/colors.mjs'), 'utf8'), colors);
    succeeds();
    assert.equal(readFileSync(target, 'utf8'), patched);

    writeFileSync(snapshot, '{truncated');
    assert.equal(run().status, 1);
    assert.equal(readFileSync(target, 'utf8'), patched);
    writeFileSync(snapshot, backup);
    if (graph) {
      writeFileSync(join(dir, 'bunfs/extra.js'), '// mismatched graph');
      assert.equal(run().status, 1);
      assert.equal(readFileSync(target, 'utf8'), patched);
      rmSync(join(dir, 'bunfs/extra.js'));
    }
    // A fresh extraction changes the version and must replace the old backup.
    writeSource('2.1.284');
    assert.equal(run().status, 1, 'reject mismatched backup version');
    succeeds('--capture-clean-source');
    assert.equal(JSON.parse(readFileSync(snapshot)).version, '2.1.284');
    assert.match(readFileSync(entry + '.bak', 'utf8'), /Version: 2.1.284/);
    succeeds();

    // A valid patch alongside a stale one must not leave a partial installation.
    rmSync(snapshot);
    rmSync(entry + '.bak');
    writeSource('2.1.284', 'const unsupported=\'.command("update").alias("upgrade")\';');
    const before = readFileSync(target, 'utf8');
    for (const args of [[], ['--dry-run']]) {
      const failed = run(...args);
      assert.equal(failed.status, 1);
      assert.match(failed.stdout, /regex stale/);
      assert.equal(readFileSync(target, 'utf8'), before);
      assert.equal(existsSync(entry + '.bak'), false);
      if (graph) assert.equal(readFileSync(join(dir, 'bunfs/colors.mjs'), 'utf8'), colors);
    }
  }
  if (process.platform !== 'win32') {
    // Exercise the real shell preflight and failure propagation without a
    // download or a Claude/Bun installation.
    const template = readFileSync(new URL('../templates/install.sh', import.meta.url), 'utf8');
    const start = template.indexOf('mkdir -p "$CLAWGOD_DIR" "$BIN_DIR"', template.indexOf('# ─── Handle --no-upgrade'));
    const selection = template.slice(start, template.indexOf('if [ "$NO_UPGRADE" != "1" ]; then', start));
    assert.ok(selection.includes('Recovering clean source'));
    const dir = join(root, 'shell');
    mkdirSync(dir);
    const env = { ...process.env, CLAWGOD_DIR: dir, BIN_DIR: join(dir, 'bin'), NO_UPGRADE: '1', VERSION: 'latest' };
    const shell = body => spawnSync('bash', ['-c', 'set -e\ninfo() { echo "$*"; }; warn() { echo "$*"; }; dim() { :; };\n' + body], { env, encoding: 'utf8' });
    writeFileSync(join(dir, 'cli.original.cjs'), '// Version: 2.1.272');
    writeFileSync(join(dir, '.source-version'), '2.1.283\n');
    let result = shell(selection + '\necho "CHOICE=$NO_UPGRADE,$VERSION"');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CHOICE=0,2.1.283/);
    rmSync(join(dir, '.source-version'));
    result = shell(selection + '\necho "CHOICE=$NO_UPGRADE,$VERSION"');
    assert.match(result.stdout, /CHOICE=0,2.1.272/);
    writeFileSync(join(dir, 'source-backup.json'), '{}');
    result = shell(selection + '\necho "CHOICE=$NO_UPGRADE,$VERSION"');
    assert.match(result.stdout, /CHOICE=1,latest/);
    rmSync(join(dir, 'source-backup.json'));
    writeFileSync(join(dir, 'cli.original.cjs'), '// unknown version');
    assert.equal(shell(selection).status, 1);
    writeFileSync(join(dir, 'patch.mjs'), 'process.exit(7)');
    const applyStart = template.indexOf('# ─── Apply patches');
    const apply = template.slice(applyStart, template.indexOf('# ─── Report which renderer', applyStart));
    result = shell(apply + '\necho UNEXPECTED_SUCCESS');
    assert.equal(result.status, 7);
    assert.match(result.stdout, /Installation aborted/);
    assert.match(result.stdout, /No previous working installation found to roll back/);
    assert.match(result.stdout, /To install or roll back to a known compatible version/);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_SUCCESS/);

    // Rollback test: simulate an existing working installation before upgrade fails
    const rollbackDir = join(dir, 'rollback-test');
    mkdirSync(rollbackDir);
    const backupDir = join(rollbackDir, 'backup');
    mkdirSync(backupDir);
    writeFileSync(join(backupDir, 'cli.original.cjs'), '// Old working 2.1.280');
    writeFileSync(join(backupDir, '.source-version'), '2.1.280\n');
    writeFileSync(join(rollbackDir, 'cli.original.cjs'), '// Broken candidate 2.1.299');
    writeFileSync(join(rollbackDir, '.source-version'), '2.1.299\n');
    writeFileSync(join(rollbackDir, 'patch.mjs'), 'process.exit(9)');
    
    const rollbackEnv = { ...env, CLAWGOD_DIR: rollbackDir, PREV_BACKUP_DIR: backupDir, NATIVE_BIN_LABEL: '2.1.299' };
    const rollbackShell = body => spawnSync('bash', ['-c', 'set -e\ninfo() { echo "$*"; }; warn() { echo "$*"; }; dim() { :; };\n' + body], { env: rollbackEnv, encoding: 'utf8' });
    result = rollbackShell(apply + '\necho UNEXPECTED_SUCCESS');
    assert.equal(result.status, 9);
    assert.match(result.stdout, /Restored previous working installation \(2.1.280\)/);
    assert.match(result.stdout, /The new Claude Code build \(2.1.299\) is not yet supported/);
    assert.equal(readFileSync(join(rollbackDir, '.source-version'), 'utf8').trim(), '2.1.280');
    assert.equal(readFileSync(join(rollbackDir, 'cli.original.cjs'), 'utf8'), '// Old working 2.1.280');
    assert.equal(existsSync(backupDir), false, 'rollback temp dir cleaned up');
  }
  console.log('[source-backup.test] complete backups, repeated patching, revert, validation, upgrades, and failure without source writes passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
