# ClawGod 完整备份 — 二开增强版

这是 clawgod 的完整备份，包含 **40 个补丁（支持 Claude Code 2.1.142-2.1.143）** + cli.cjs 智能配置 + wiki 知识库。

## 目录结构

| 文件 | 说明 |
|------|------|
| `patch.mjs` | **32 个补丁**（核心文件，支持 Claude Code 2.1.142-2.1.143） |
| `cli.cjs` | **智能包装器**（自动检测第三方 API → 注入优化配置） |
| `.source-version` | 当前支持的 Claude Code 版本 |
| `post-process.mjs` | 后处理脚本（含 .node require 的 try/catch 修复） |
| `extract-natives.mjs` | Bun SEA 原生模块提取脚本 |
| `repatch.mjs` | 重打补丁助手 |
| `features.json` | 特征标志配置（GrowthBook overrides） |
| `provider.json` | API 提供者配置模板 |
| `vendor/` | 提取的 .node 原生模块 |
| `wiki/` | **LLM 知识库**（包含完整分析文档） |

> `cli.original.cjs`（已打补丁的源码）为可生成文件，不纳入 git 追踪。
> 运行 `node patch.mjs` 即可从官方二进制自动提取并打补丁。

## 官方更新后重新破解流程

```bash
# 1. 确认当前版本
cat ~/.clawgod/.source-version

# 2. 安装新版 Claude Code
bash ~/.clawgod/install.sh

# 3. 运行补丁（自动应用 31 个补丁）
node ~/.clawgod/patch.mjs

# 4. 如果补丁失败（regex stale），查看 wiki 的重新破解指南
```

## 31 个补丁清单

见 `wiki/clawgod/clawgod-comprehensive-analysis.md` 第八章。

### 与上游（0Chencc/clawgod）的差异

- 修复了 `patch.mjs` 中 beta header 剥离的正则表达式，支持 2.1.143（minified 函数名 Lq→Jq 变化）
- `NI6()`/`dI6()` 函数中的 DISABLE_EXPERIMENTAL_BETAS 门禁在 2.1.143 中已移除，补丁自动适配
- 新增补丁 #32：WebSearch isEnabled() 前置 ANTHROPIC_BASE_URL 检测，防止模型在第三方 API 下仍然使用内置 web_search 而非 Tavily MCP
- 所有补丁通过 `--verify` 模式验证，确保无 regressions
- 完整的 LLM wiki 知识库（包含反限制分析、性能修复、架构文档）

## 关键知识

所有分析文档在 `wiki/` 目录中，包括：
- 反第三方限制绕过原理（3 层架构：GrowthBook → 门禁函数 → 消息过滤）
- Tool Search / 子 Agent 修复
- Beta header 过滤机制
- 性能优化（1h prompt cache、流超时、esbuild 去除）
- GitHub Issue 分析（570+ 条）
- 官方更新后重新破解指南
- 31 个补丁的详细说明

## 分支策略

| 分支 | 追踪 | 说明 |
|------|------|------|
| `main` | `origin/main`（gdlwolf） | 接收上游（0Chencc）更新 |
| `dev` | 无（二开分支） | 我们的开发分支，cherry-pick 上游有用 commit |

```bash
# 同步上游更新
git checkout main && git pull origin main
git checkout dev && git merge main
```
