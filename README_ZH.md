# ClawGod

[English](README.md) | [中文](README_ZH.md) | [日本語](README_JP.md)

[![Latest](https://img.shields.io/github/v/release/0chencc/clawgod?style=flat&label=Latest)](https://github.com/0Chencc/clawgod/releases/latest)
[![Released](https://img.shields.io/github/release-date/0chencc/clawgod?style=flat&label=Released)](https://github.com/0Chencc/clawgod/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/0chencc/clawgod/total?style=flat&label=Downloads)](https://github.com/0Chencc/clawgod/releases)

> [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 上帝模式。

**这不是第三方 Claude Code 客户端。** ClawGod 是作用在官方 Claude Code 之上的运行时补丁。它兼容任何版本——当 Claude Code 升级，ClawGod 会在下次启动时自动从新版本重新抽取并重新打补丁。

## 前置依赖

运行 ClawGod 安装脚本**之前**先装好：

| 工具 | 用途 | 安装 |
|------|------|------|
| **Claude Code**（原生二进制） | ClawGod 是基于你已装的官方 Bun standalone 二进制做 patch | [`claude.ai/install.sh`](https://claude.ai/install.sh)（macOS/Linux）或 [`claude.ai/install.ps1`](https://claude.ai/install.ps1)（Windows） |
| **ripgrep** | Claude Code 内置 Grep tool 必需 | `brew install ripgrep` / `apt install ripgrep` / `winget install BurntSushi.ripgrep.MSVC` |
| **Node.js >= 18** | patcher 使用 | [nodejs.org](https://nodejs.org) |

[Bun](https://bun.sh) 是运行 patched cli.js 的 runtime——installer 检测不到时会自动安装。

## 安装

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 | iex
```

绿色 Logo = 已 Patch。橙色 Logo = 原版。

![ClawGod 效果展示](bypass.png)

## 功能一览

### 功能解锁

| 补丁 | 效果 |
|------|------|
| **内部用户模式** | 24+ 隐藏命令（`/share`、`/teleport`、`/issue`、`/bughunter`...），调试日志，API 请求记录 |
| **GrowthBook 覆盖** | 通过配置文件覆盖任意 Feature Flag |
| **Agent Teams** | 多智能体协作，无需额外参数 |
| **Computer Use** | 无需 Max/Pro 订阅即可使用屏幕控制（macOS） |
| **Auto-mode** | 解锁第三方 API 用户的 auto-mode（移除 firstParty 限制） |
| **Ultraplan** | 通过 Claude Code Remote 进行多智能体规划 |
| **Ultrareview** | 通过 Claude Code Remote 自动化 Bug 查找 |

### 限制移除

| 补丁 | 移除内容 |
|------|---------|
| **CYBER_RISK_INSTRUCTION** | 安全测试拒绝提示（渗透测试、C2 框架、漏洞利用） |
| **URL 限制** | "禁止生成或猜测 URL" 指令 |
| **操作审慎** | 破坏性操作前的强制确认 |
| **登录提示** | 启动时的"未登录"提醒 |

### 视觉

| 补丁 | 效果 |
|------|------|
| **绿色主题** | 品牌色 → 绿色，一眼辨别是否已 Patch |
| **消息过滤** | 显示对非 Anthropic 用户隐藏的内容 |

### 可靠性

| 功能 | 作用 |
|------|------|
| **1h Prompt Cache** | 强制启用 1h TTL allowlist（默认实际是 5m → 空闲后导致大量 cache_creation token 浪费） |
| **自动重打补丁** | 检测到用户官方升级了 native Claude binary 时，下次启动自动重新抽取 + 重新 patch |

## 使用

```bash
claude              # 已 Patch 的 Claude Code（替换官方 launcher）
clawgod             # 同 `claude`，显式且永远生效的入口
claude.orig         # 原版未修改版本（自动备份）
```

`clawgod` 是一个无歧义的入口：Windows 上即便 `claude.exe` 抢占了 `claude.cmd`，`clawgod.cmd` 始终生效；即便官方自动更新覆盖了 `claude`，`clawgod` 仍跑 patched 版本。

## 配置

首次启动会自动生成 `~/.clawgod/provider.json`。填入 `apiKey` 即可**跳过 OAuth 登录**，对接任何 Anthropic 协议端点。

```json
{
  "apiKey": "sk-ant-...",
  "baseURL": "https://api.anthropic.com",
  "model": "",
  "smallModel": "",
  "timeoutMs": 3000000
}
```

- **填写 `apiKey`**：ClawGod 注入 `ANTHROPIC_API_KEY` 并与 `~/.claude/settings.json` 隔离。可用于 Anthropic 官方、DeepSeek，以及任何 OpenAI-compatible 网关；`baseURL` 指向非 Anthropic 域名时，还会自动注入 `ANTHROPIC_AUTH_TOKEN` 以适配网关鉴权。
- **留空 `apiKey`**：走 OAuth 路径，执行一次 `claude auth login`，`~/.claude` 下的 subagents / skills / MCP 配置继续有效。

## 工作原理

从 `@anthropic-ai/claude-code` v2.1.113 起，npm 包不再带 `cli.js`——它只是个 thin loader 转发到平台特定的 Bun standalone 二进制。ClawGod 这样适配：

1. 在 `~/.local/share/claude/versions/` 定位用户已装的 Bun native binary
2. 从 `__BUN` segment（Mach-O / ELF / PE）抽出嵌入的 `cli.js` 源码
3. 抽出嵌入的 `.node` 原生模块（audio-capture、image-processor、computer-use-*、url-handler）放到 `~/.clawgod/vendor/`
4. 把 `/$bunfs/...` 虚拟路径重写到本地 vendor 路径
5. 应用 23 条正则 patch（跨版本兼容，同一组 regex 覆盖多个 release）
6. `claude` / `clawgod` launcher 在 Bun runtime 下跑 patched cli.js

`~/.clawgod/.source-version` 标记当时被 patch 的版本号。每次启动 wrapper 比对它和 `versions/` 里最新二进制；如果用户走官方途径升级了 Claude Code，下次启动会自动重打补丁。

## 更新

installer 是幂等的——再跑一次即可刷新 patched 副本：

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash
```

**Windows:**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 | iex
```

通常**不需要**手动重跑——Claude Code 自动更新后，ClawGod 的自动重打补丁会在下次 `claude` / `clawgod` 启动时自动处理。

## 卸载

**macOS / Linux:**
```bash
curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash -s -- --uninstall
hash -r  # 刷新 shell 缓存
```

**Windows:**
```powershell
irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 -OutFile install.ps1; .\install.ps1 -Uninstall
```

卸载会把 `claude.orig` 还原成 `claude`，并移除 `clawgod` 别名。

> 安装或卸载后，如果命令未立即生效，请重启终端或执行 `hash -r`。

## 许可证

GPL-3.0 — 与 Anthropic 无关，风险自负。
