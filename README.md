# ClawGod

[English](README.md) | [中文](README_ZH.md) | [日本語](README_JP.md)

[![Latest](https://img.shields.io/github/v/release/0chencc/clawgod?style=flat&label=Latest)](https://github.com/0Chencc/clawgod/releases/latest)
[![Released](https://img.shields.io/github/release-date/0chencc/clawgod?style=flat&label=Released)](https://github.com/0Chencc/clawgod/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/0chencc/clawgod/total?style=flat&label=Downloads)](https://github.com/0Chencc/clawgod/releases)
[![Compat](https://img.shields.io/github/actions/workflow/status/0chencc/clawgod/compat-daily.yml?branch=main&style=flat&label=Compat)](https://github.com/0Chencc/clawgod/actions/workflows/compat-daily.yml)
[![Claude tested](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/0Chencc/clawgod/badges/claude-version.json&style=flat)](https://github.com/0Chencc/clawgod/actions/workflows/compat-daily.yml)

> God mode for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

**This is NOT a third-party Claude Code client.** ClawGod is a runtime patch applied on top of the official Claude Code. It works with any version — as Claude Code updates, ClawGod automatically re-extracts and re-patches against the new version on the next launch.

## Prerequisites

Install these **before** running the ClawGod installer:

| Tool | Why | Install |
|------|-----|---------|
| **Claude Code** (native binary) | ClawGod patches the official Bun standalone binary you already have | [`claude.ai/install.sh`](https://claude.ai/install.sh) (macOS/Linux) or [`claude.ai/install.ps1`](https://claude.ai/install.ps1) (Windows) |
| **ripgrep** | Required by Claude Code's Grep tool | `brew install ripgrep` / `apt install ripgrep` / `winget install BurntSushi.ripgrep.MSVC` |
| **Node.js >= 18** | Used by the patcher | [nodejs.org](https://nodejs.org) |
| **Bun** | Runtime for the patched cli.js; auto-installed if missing | [bun.sh](https://bun.sh), `npm install -g bun`, `scoop install bun`, or `choco install bun` |

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
| **Classifier tuning** | Tunable auto-mode classifier: timeout / model / retries (`CLAWGOD_CLASSIFIER_TIMEOUT_MS`, `CLAWGOD_CLASSIFIER_MODEL`, `CLAWGOD_CLASSIFIER_RETRIES`) |
| **Ultraplan** | Multi-agent planning via Claude Code Remote |
| **Ultrareview** | Automated bug hunting via Claude Code Remote |

### Restriction Removals

| Patch | What's removed |
|-------|---------------|
| **CYBER_RISK_INSTRUCTION** | Security testing refusal (pentesting, C2, exploits) |
| **URL Restriction** | "NEVER generate or guess URLs" instruction |
| **Cautious Actions** | Forced confirmation before destructive operations |
| **Login Notice** | "Not logged in" startup reminder |

### Geo-Steganography Neutralization

| Patch | What's neutralized |
|-------|-------------------|
| **Date String (qla)** | System prompt encodes user location via Unicode apostrophe variants (U+0027 / U+2019 / U+02BC / U+02B9) and date separator (`-` vs `/` for CN timezone). Patched to always use ASCII `'` and unmodified date format |
| **Geo-Detection Probe (rdp)** | Client-side three-axis detection: timezone (`Asia/Shanghai` / `Asia/Urumqi`), proxy hostname against XOR-obfuscated 100+ domain blocklist, CN-LLM vendor keywords in base URL. Patched to always return null |
| **Apostrophe Selector (odp)** | Selects one of four Unicode apostrophes based on detection results. Patched to always return ASCII `'` (defense-in-depth) |

### Visual

| Patch | Effect |
|-------|--------|
| **Green Theme** | Brand color → green. Patched at a glance |
| **Message Filters** | Shows content hidden from non-Anthropic users |

### Reliability

| Feature | What it does |
|---------|-------------|
| **Glob/Grep Restore** | Bun compile inlines `EMBEDDED_SEARCH_TOOLS=true`, hiding built-in Glob/Grep tools. Patch un-inlines the env check and adds bfs/ugrep binary availability detection — tools are restored when running under Bun runtime |
| **1h Prompt Cache** | Forces 1h TTL allowlist on (was effectively 5m → much higher cache_creation token usage) |
| **Third-Party Cache Fix** | Auto-disables `x-anthropic-billing-header` when `baseURL` is non-Anthropic. The header's per-request `cch` field breaks prompt-cache hit rate on DeepSeek / OneAPI / Bedrock / vLLM and any other Anthropic-compatible proxy. You no longer need to set `CLAUDE_CODE_ATTRIBUTION_HEADER=0` yourself. |
| **Auto Re-patch** | Detects when the user's native Claude binary has been upgraded; transparently re-extracts and re-patches on next launch |
| **Update Notification** | Checks GitHub releases once per 24h (async, non-blocking). Shows a one-line notice if a newer ClawGod version is available |
| **Lean Settings** | Three-level token optimization for `~/.claude/settings.json`. **on** (default): removes unused tool definitions + disables Workflows/RemoteControl/Artifact. **max**: additionally removes Plan mode, Agent Teams, bundled skills. **off**: all tools restored |

> **Lean Settings** are non-destructive and persist across updates. Toggle anytime: `claude --lean-on` (default) / `claude --lean-max` (aggressive) / `claude --lean-off` (restore all). To opt out of a single setting, set it yourself (e.g. `"disableArtifact": false`).

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

### Feature Toggles

`~/.clawgod/patches.json` (auto-created empty) switches features off persistently — your choices survive updates and reinstalls. Absent key = on.

```json
{ "theme": false, "geo-neutralize": false }
```

| Feature id | Controls |
|------------|----------|
| `agent-teams` | Agent Teams always enabled |
| `computer-use` | Computer Use unlock |
| `ultraplan` | Ultraplan slash command |
| `ultrareview` | Ultrareview slash command |
| `voice-mode` | Voice Mode |
| `auto-mode` | Auto-mode model selection on third-party APIs |
| `classifier-tuning` | Auto-mode classifier overrides: `CLAWGOD_CLASSIFIER_TIMEOUT_MS` (min deadline; unset = 60-120s by context, v2.1.251+), `CLAWGOD_CLASSIFIER_MODEL`, `CLAWGOD_CLASSIFIER_RETRIES` (unset = 4) |
| `theme` | Green brand/logo color scheme |
| `geo-neutralize` | Geo/proxy steganography neutralization in system prompt |
| `cyber-risk` | Removes CYBER_RISK_INSTRUCTION from system prompt |
| `url-restriction` | Removes URL generation restriction from system prompt |
| `cautious-actions` | Removes "Executing actions with care" section from system prompt |
| `not-logged-in` | Removes "Not logged in" notice |
| `message-filter` | Bypasses non-ant message/attachment filters |

For a single launch, set an env var instead — feature id upper-cased, dashes to underscores:

```bash
CLAWGOD_FEATURE_THEME=false claude     # green theme off, this run only
CLAWGOD_FEATURE_GEO_NEUTRALIZE=true claude  # temporarily re-enable one disabled in patches.json
```

## How it works

Since `@anthropic-ai/claude-code` v2.1.113, the npm package no longer ships `cli.js` — it's a thin loader that dispatches to platform-specific Bun standalone binaries. ClawGod adapts:

1. Locates the user's installed native Bun binary in `~/.local/share/claude/versions/`
2. Extracts the embedded `cli.js` source from the `__BUN` segment (Mach-O / ELF / PE)
3. Extracts the embedded `.node` native modules (audio-capture, image-processor, computer-use-*, url-handler) into `~/.clawgod/vendor/`
4. Rewrites `/$bunfs/...` virtual paths to point at the extracted modules
5. Applies 29 regex-based patches (version-agnostic — same patches work across many releases)
6. The `claude` / `clawgod` launchers run the patched cli.js under the Bun runtime

A `.source-version` stamp in `~/.clawgod/` records which native version was patched. On every launch the wrapper compares it against the latest binary in `versions/`; if the user upgraded Claude Code via the official installer, ClawGod auto-re-patches on the next run.

## Update

**Just run `claude update` as usual.** ClawGod patches the command to route through its own installer, which pulls the current Anthropic release from npm (`@anthropic-ai/claude-code-<plat>@latest`), re-extracts cli.js, re-applies patches, and rewrites the launcher. So the upstream update command keeps working the way you expect — you get the latest Claude, with patches still applied, in one step.

Extra options:

```bash
claude update --version 2.1.180   # Pin to a specific Claude Code version
claude update --no-upgrade        # Re-patch without downloading (use existing cli.js)
```

`--version` is useful when a new release has issues and you want to stay on a known-good version. `--no-upgrade` re-applies the latest patches from the installer to the existing cli.js — handy when only the patcher has been updated.

If you'd rather invoke the installer directly (same effect, both paths fetch the same upstream release and re-patch):

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash
```

**Windows:**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 | iex
```

If you'd rather drop ClawGod and use Anthropic's original `claude update` (which manages its own paths and would overwrite our launcher), uninstall first:

```bash
bash ~/.clawgod/install.sh --uninstall
```

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

## Star History

<a href="https://www.star-history.com/?repos=0chencc%2Fclawgod&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=0chencc/clawgod&type=date&theme=dark&legend=top-left&sealed_token=ntGY6im49ymMeD9BXSi0OmH_kyhnnTL9pGyfm2rLYBTlzEcTeQf4o6RA6HqXhGVzdD6xXlk20KCFAyk4gWIpEda3TVEm4re4eJ0xoosRcUdYMui5B7Hp6e3YBUAr2tWmCZu2ZkRWVCOEdCOldK9S_h7Jn7NIjGEEgWywl2ZZOq7xpUpT4IkkXKKxGNJi" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=0chencc/clawgod&type=date&legend=top-left&sealed_token=ntGY6im49ymMeD9BXSi0OmH_kyhnnTL9pGyfm2rLYBTlzEcTeQf4o6RA6HqXhGVzdD6xXlk20KCFAyk4gWIpEda3TVEm4re4eJ0xoosRcUdYMui5B7Hp6e3YBUAr2tWmCZu2ZkRWVCOEdCOldK9S_h7Jn7NIjGEEgWywl2ZZOq7xpUpT4IkkXKKxGNJi" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=0chencc/clawgod&type=date&legend=top-left&sealed_token=ntGY6im49ymMeD9BXSi0OmH_kyhnnTL9pGyfm2rLYBTlzEcTeQf4o6RA6HqXhGVzdD6xXlk20KCFAyk4gWIpEda3TVEm4re4eJ0xoosRcUdYMui5B7Hp6e3YBUAr2tWmCZu2ZkRWVCOEdCOldK9S_h7Jn7NIjGEEgWywl2ZZOq7xpUpT4IkkXKKxGNJi" />
 </picture>
</a>
