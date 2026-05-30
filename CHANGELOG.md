# Changelog

## Unreleased

### Added

- Added a sidecar install mode for ClawGod:
  - macOS/Linux: `install.sh --sidecar`
  - Windows: `install.ps1 -Sidecar`
- Sidecar mode installs only the explicit `clawgod` / `clawgod.cmd` launcher.
- Sidecar mode leaves the native Claude Code command unchanged:
  - does not overwrite `claude`
  - does not remove `claude.exe`
  - does not create or rely on `claude.orig`
- Added `~/.clawgod/install-mode` so self-updates preserve the chosen install mode.
- In sidecar mode, `clawgod update` refreshes the patched ClawGod copy while native `claude update` remains Anthropic's own updater.
- Added installer regression tests for sidecar mode and current Auto-mode patch patterns.

### Changed

- Updated English, Chinese, and Japanese README files to document default install mode versus sidecar install mode.
- Updated the compatibility workflow to run installer static tests on PRs that touch installer code.

### Fixed

- Updated the Auto-mode unlock patch for Claude Code `2.1.158`, where the previous single provider gate was split into an environment gate and a model-family gate.

### Verified

- `node tests/auto-mode-patterns.test.mjs`
- `tests/sidecar-mode.test.sh`
- `bash -n install.sh`
- `git diff --check`
- `bash install.sh --sidecar`
- `clawgod --version` returned `2.1.158 (Claude Code)`
- Confirmed native `claude` still resolved to `/opt/homebrew/bin/claude` after sidecar install.
