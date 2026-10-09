import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The Windows half of this lives in src/windows/launchers.test.ps1.
if (process.platform === 'win32') {
  console.log('[native-refresh.test] skipped on Windows');
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'clawgod-native-refresh-'));
try {
  // Run the real installer section: from the refresh down to the launcher.
  const template = readFileSync(new URL('../templates/install.sh', import.meta.url), 'utf8');
  const start = template.indexOf('# Refresh claude.orig from the binary this run extracted.');
  const section = template.slice(start, template.indexOf('# Write launcher to the SAME directory', start));
  assert.ok(start > 0 && section.includes('# Back up original claude (only once)'));

  const clawgod = join(root, '.clawgod');
  const bin = join(root, 'bin');
  const versions = join(root, '.local/share/claude/versions');
  for (const dir of [clawgod, bin, versions]) mkdirSync(dir, { recursive: true });
  const claude = join(bin, 'claude');
  const orig = claude + '.orig';
  const staged = join(clawgod, 'claude.staged');
  const env = { ...process.env, HOME: root, CLAWGOD_DIR: clawgod, CLAUDE_BIN: claude };
  const cleanupStart = template.indexOf('# A failed earlier upgrade may have left a newer native binary staged.');
  const cleanup = template.slice(cleanupStart, template.indexOf('# ─── Write re-patch helper', cleanupStart));
  assert.ok(cleanupStart > 0);
  writeFileSync(staged, 'stale newer binary');
  const cleanupResult = spawnSync('bash', ['-c', 'set -e\n' + cleanup], { env: { ...env, NO_UPGRADE: '1' }, encoding: 'utf8' });
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr);
  assert.equal(existsSync(staged), false, '--no-upgrade must discard a stale staged binary');
  const install = () => {
    const result = spawnSync('bash', ['-c', 'set -e\ninfo() { echo "$*"; }; warn() { echo "$*"; }; dim() { :; };\n' + section], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  // Native install that clawgod already wrapped: claude.orig is the symlink
  // taken at first install and still points at the version from back then.
  const old = join(versions, '2.1.270');
  writeFileSync(old, 'native 2.1.270', { mode: 0o755 });
  symlinkSync(old, orig);
  writeFileSync(claude, '#!/bin/bash\n# clawgod launcher\n', { mode: 0o755 });

  // --no-upgrade stages nothing and must leave the backup alone.
  assert.doesNotMatch(install(), /refreshed/);
  assert.ok(lstatSync(orig).isSymbolicLink());

  // An upgrade replaces the link itself, not the file behind it.
  writeFileSync(staged, 'native 2.1.291');
  assert.match(install(), /Native binary refreshed/);
  assert.equal(lstatSync(orig).isSymbolicLink(), false);
  assert.equal(readFileSync(orig, 'utf8'), 'native 2.1.291');
  assert.ok(lstatSync(orig).mode & 0o100, 'claude.orig must be executable');
  assert.equal(readFileSync(old, 'utf8'), 'native 2.1.270', 'wrote through the symlink into versions/');
  assert.equal(existsSync(staged), false);

  // First install: the staged binary wins over whatever the backup would find.
  rmSync(orig);
  rmSync(claude);
  symlinkSync(old, claude);
  writeFileSync(staged, 'native 2.1.291');
  const first = install();
  assert.match(first, /Native binary refreshed/);
  assert.doesNotMatch(first, /backed up/);
  assert.equal(readFileSync(orig, 'utf8'), 'native 2.1.291');

  console.log('[native-refresh.test] upgrade refresh, symlink safety, no-upgrade, and first install passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
