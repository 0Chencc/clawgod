# ClawGod

[English](README.md) | [中文](README_ZH.md) | [日本語](README_JP.md)

[![Latest](https://img.shields.io/github/v/release/0chencc/clawgod?style=flat&label=Latest)](https://github.com/0Chencc/clawgod/releases/latest)
[![Released](https://img.shields.io/github/release-date/0chencc/clawgod?style=flat&label=Released)](https://github.com/0Chencc/clawgod/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/0chencc/clawgod/total?style=flat&label=Downloads)](https://github.com/0Chencc/clawgod/releases)

> God mode for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

**This is NOT a third-party Claude Code client.** ClawGod is a runtime patch applied on top of the official Claude Code. It works with any version — as Claude Code updates, ClawGod automatically re-extracts and re-patches against the new version on the next launch.

## Prerequisites

Install these **before** running the ClawGod installer:

| Tool | Why | Install |
|------|-----|---------|
| **Claude Code** (native binary) | ClawGod patches the official Bun standalone binary you already have | [`claude.ai/install.sh`](https://claude.ai/install.sh) (macOS/Linux) or [`claude.ai/install.ps1`](https://claude.ai/install.ps1) (Windows) |
| **ripgrep** | Required by Claude Code's Grep tool | `brew install ripgrep` / `apt install ripgrep` / `winget install BurntSushi.ripgrep.MSVC` |
| **Node.js >= 18** | Used by the patcher | [nodejs.org](https://nodejs.org) |

[Bun](https://bun.sh) is the runtime that executes the patched cli.js — the installer auto-installs it if missing.

## Install

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 | iex
```

Green logo = patched. Orange logo = original.

![ClawGod Patched](bypass.png)

## What it does

### Feature Unlocks

| Patch | What you get |
|-------|-------------|
| **Internal User Mode** | 24+ hidden commands (`/share`, `/teleport`, `/issue`, `/bughunter`...), debug logging, API request dumps |
| **GrowthBook Overrides** | Override any feature flag via config file |
| **Agent Teams** | Multi-agent swarm collaboration, no flags needed |
| **Computer Use** | Screen control without Max/Pro subscription (macOS) |
| **Auto-mode** | Unlocks auto-mode for third-party API users (no firstParty gate) |
| **Ultraplan** | Multi-agent planning via Claude Code Remote |
| **Ultrareview** | Automated bug hunting via Claude Code Remote |

### Restriction Removals

| Patch | What's removed |
|-------|---------------|
| **CYBER_RISK_INSTRUCTION** | Security testing refusal (pentesting, C2, exploits) |
| **URL Restriction** | "NEVER generate or guess URLs" instruction |
| **Cautious Actions** | Forced confirmation before destructive operations |
| **Login Notice** | "Not logged in" startup reminder |

### Visual

| Patch | Effect |
|-------|--------|
| **Green Theme** | Brand color → green. Patched at a glance |
| **Message Filters** | Shows content hidden from non-Anthropic users |

### Reliability

| Feature | What it does |
|---------|-------------|
| **1h Prompt Cache** | Forces 1h TTL allowlist on (was effectively 5m → much higher cache_creation token usage) |
| **Auto Re-patch** | Detects when the user's native Claude binary has been upgraded; transparently re-extracts and re-patches on next launch |

## Commands

```bash
claude              # Patched Claude Code (replaces the official launcher)
clawgod             # Same as `claude`, explicit & guaranteed entry point
claude.orig         # Original unpatched version (auto-backed-up)
```

`clawgod` is unambiguous: on Windows where `claude.exe` may shadow `claude.cmd`, `clawgod.cmd` always works. Even after official self-update overwrites `claude`, `clawgod` keeps running the patched build.

## Configuration

`~/.clawgod/provider.json` is auto-created on first run. Setting `apiKey` lets you skip OAuth entirely and point ClawGod at any Anthropic-compatible endpoint.

```json
{
  "apiKey": "sk-ant-...",
  "baseURL": "https://api.anthropic.com",
  "model": "",
  "smallModel": "",
  "timeoutMs": 3000000
}
```

- **`apiKey` set** → ClawGod injects it as `ANTHROPIC_API_KEY` and isolates from `~/.claude/settings.json`. Works with Anthropic, DeepSeek, and OpenAI-compatible gateways. A non-Anthropic `baseURL` also populates `ANTHROPIC_AUTH_TOKEN` for gateway auth.
- **`apiKey` empty** → OAuth path. Run `claude auth login` once; `~/.claude` keeps hosting your subagents, skills, and MCP settings.

## How it works

Since `@anthropic-ai/claude-code` v2.1.113, the npm package no longer ships `cli.js` — it's a thin loader that dispatches to platform-specific Bun standalone binaries. ClawGod adapts:

1. Locates the user's installed native Bun binary in `~/.local/share/claude/versions/`
2. Extracts the embedded `cli.js` source from the `__BUN` segment (Mach-O / ELF / PE)
3. Extracts the embedded `.node` native modules (audio-capture, image-processor, computer-use-*, url-handler) into `~/.clawgod/vendor/`
4. Rewrites `/$bunfs/...` virtual paths to point at the extracted modules
5. Applies 23 regex-based patches (version-agnostic — same patches work across many releases)
6. The `claude` / `clawgod` launchers run the patched cli.js under the Bun runtime

A `.source-version` stamp in `~/.clawgod/` records which native version was patched. On every launch the wrapper compares it against the latest binary in `versions/`; if the user upgraded Claude Code via the official installer, ClawGod auto-re-patches on the next run.

## Update

The installer is idempotent — run it again to refresh the patched copy:

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash
```

**Windows:**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 | iex
```

In most cases you don't need to do this — when Claude Code self-updates, ClawGod's auto-re-patch picks up the new version automatically on the next `claude` / `clawgod` invocation.

## Uninstall

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash -s -- --uninstall
hash -r  # refresh shell cache
```

**Windows:**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 -OutFile install.ps1; .\install.ps1 -Uninstall
```

Uninstall restores `claude.orig → claude` and removes the `clawgod` alias.

> After install or uninstall, restart your terminal or run `hash -r` if the command doesn't take effect immediately.

## License

GPL-3.0 — Not affiliated with Anthropic. Use at your own risk.
