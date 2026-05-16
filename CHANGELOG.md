# Changelog

## dev (unreleased)

### Added

- **Dev branch init**: full clawgod toolchain with 31 patches, LLM wiki, and third-party API enhancements
- **LLM knowledge base** (`wiki/`): comprehensive analysis covering bypass architecture (3-layer: GrowthBook → gate functions → message filters), all 32 patches catalog, performance fixes, and re-crack guide
- **`.source-version` tracking**: records which Claude Code version the patched binary corresponds to
- **`.gitignore`**: excludes regeneratable 14MB binary artifacts from git tracking
- **Patch #32 — Disable WebSearch isEnabled for third-party API**: `Dq()`/`vq()` 默认返回 `"firstParty"`（无环境变量时），导致 web_search 工具的 `isEnabled()` 返回 `true`，模型仍能看到内置 web_search 工具而非 Tavily MCP。在 `isEnabled()` 开头添加 `ANTHROPIC_BASE_URL` 检测，和 VH5() 的检测逻辑一致，实现 tool definition 层的第三方 API 禁用

### Fixed

- **Beta header stripping regex**: minified header-merge function name changed from `Lq` to `Jq` in Claude Code 2.1.143 — regex now uses `([\w$]+)` capture group to match any minified name, ensuring cross-version compatibility
- **Auto-mode unlock regex**: supports Claude Code 2.1.139+ multi-var `let` syntax (cherry-picked from 0Chencc/clawgod)
- **Windows launcher encoding**: resolves garbled characters in `.cmd` launcher for non-ASCII Windows usernames (cherry-picked from keyblues → 0Chencc/clawgod)
- **USERPROFILE path separator boundary**: requires path separator boundary in `USERPROFILE` prefix check (cherry-picked from keyblues → 0Chencc/clawgod)

### Changed

- **All repository references**: replaced `0Chencc/clawgod` → `gdlwolf/clawgod` across READMEs, install scripts, badges, and embedded self-update URLs
- **Install URLs**: changed from `github.com/.../releases/latest/download/` → `raw.githubusercontent.com/.../main/` so the fork is self-contained without requiring GitHub Releases
- **Default branch**: set to `dev` so visitors see the latest development content by default
- **Branch protection** on `main`: requires PR reviews, disables force push and deletion

### Patches (32 total)

- **Feature unlocks**: internal user mode, GrowthBook overrides, Agent Teams, Computer Use (no subscription), auto-mode for third-party, Ultraplan, Ultrareview
- **Restriction removals**: CYBER_RISK_INSTRUCTION, URL generation ban, cautious actions override, login notice suppression
- **Third-party API compatibility**: force `pY()`→`true` (18 call sites), beta header stripping when `DISABLE_EXPERIMENTAL_BETAS=1`, web_search null filtering + isEnabled third-party detection (dual layer), attachment filter bypass, message list filter bypass
- **Self-update**: redirect `claude update` to clawgod installer
- **Visual**: green theme (logo, brand color, shimmer, ANSI, hex)

## 2.1.143

- Added plugin dependency enforcement and `/plugin` marketplace improvements (upstream)
- Added projected context cost to `/plugin` browse pane (upstream)
- Fixed PowerShell `-ExecutionPolicy Bypass` pass-through, hook block loops, and various agent-view issues (upstream)
- **ClawGod**: 31/31 patches verified compatible — 1 regex fix required for beta header stripping (minified function name change)
- **ClawGod**: `NI6()` function completely rewritten — `DISABLE_EXPERIMENTAL_BETAS` gate removed by upstream, no patch needed
- **ClawGod**: Voice Mode `tengu_amber_quartz_disabled` feature flag removed upstream
- **ClawGod**: new `FYH()` provider gate function — existing `pY()`→`true` patch handles it

## 2.1.142

- Added new `claude agents` flags and Opus 4.7 fast mode default (upstream)
- Fixed MCP timeout, macOS sleep/wake daemon issues, Windows deadlocks, and various UI/UX fixes (upstream)
- **ClawGod**: 31 patches, full third-party API support
