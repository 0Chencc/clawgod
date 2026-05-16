# ClawGod 全面分析：性能、破解原理与子 Agent 问题

Sources: Self (OpenCode Sisyphus agent) 2026-05-15

## 一、ClawGod 是什么

ClawGod 是一个针对 Claude Code 的破解工具。它通过从 Claude Code 的 Bun 独立可执行文件中提取出 JavaScript 源码，用正则表达式修改代码，实现：

- **破解第三方模型限制**：让 Claude Code 可以使用非 Anthropic 的 API
- **解锁内部功能**：Agent Teams、Computer Use、Ultraplan、Voice Mode 等
- **移除行为限制**：安全测试拒绝、URL 生成限制、破坏操作确认等

## 二、性能问题分析

### 2.1 运行时架构开销

Claude Code 原生：ELF 二进制（自带嵌入 Bun 运行时）
ClawGod 模式：bash 启动脚本 → `bun ~/.clawgod/cli.cjs` → `require('./cli.original.cjs')`（14.5MB JavaScript）

**实测启动性能对比**：

| 指标 | 原生 claude | bun + cli.cjs | 降级倍数 |
|------|-----------|---------------|---------|
| 启动耗时 | 0.096s | 0.526s | 5.5x |
| User CPU | 0.076s | 0.460s | 6.1x |

### 2.2 源码级性能瓶颈（按严重程度排序）

1. **`USER_TYPE → "ant"` 补丁**（`patch.mjs` L913-918）
   - 将用户身份从 `"external"` 改为 `"ant"`（Anthropic 内部员工）
   - 后果：启用 24+ 隐藏内部命令、内部级别调试日志、尝试访问内部 API 端点
   - 结合第三方 API 使用时，内部代码路径尝试访问不存在的端点

2. **默认 50 分钟超时**（`cli.cjs` L843）
   - `timeoutMs: 3000000`（3,000,000ms = 50 分钟）
   - 任何发往第三方 API 的请求如果无响应，挂起 50 分钟才超时
   - 多个挂起请求堆积 → 线程/连接耗尽

3. **vendor/ 空目录导致 .node 模块缺失崩溃**
   - `post-process.mjs` 重写了 require 路径指向 `vendor/` 目录
   - 但 v2.1.142 提取时 `Found: 0 embedded native libraries`，vendor/ 为空
   - `image-processor.node`、`audio-capture.node` 等 require() 没有 try/catch 保护
   - 触发相关功能时 → MODULE_NOT_FOUND → 进程崩溃

4. **后台功能标志激活**（`features.json`）
   - `tengu_auto_background_agents: true` → 后台 Agent 自动生成
   - `tengu_session_memory: true` → 会话记忆持久化
   - `tengu_harbor: true` → 内部 Harbor 功能

5. **14.5MB JS 解析**：Bun 需要解析 14.5MB 的 cli.original.cjs 文件

6. **Computer Use 1ms 轮询**：`setInterval(c3_, 1, Sm())`，虽然 macOS-only 但在条件触发时会导致高 CPU

7. **Bun 运行时额外开销**：系统 Bun 没有原生二进制中嵌入 Bun 的预编译优化

### 2.3 已应用的四项修复

**Fix 1: post-process.mjs — .node 模块加载加 try/catch**：
```javascript
// 改前：P69.exports=require(require('path').join(__dirname,'vendor',...))
// 改后：P69.exports=((()=>{try{return require(...)}catch(e){return null}})())
```

**Fix 2: cli.cjs — 默认超时 50分钟 → 1分钟**：
```diff
- timeoutMs: 3000000,
+ timeoutMs: 60000,
```

**Fix 3: features.json — 关闭 CPU 重负载标志**：
```diff
- tengu_auto_background_agents: true
+ tengu_auto_background_agents: false
- tengu_session_memory: true
+ tengu_session_memory: false
- tengu_harbor: true
+ tengu_harbor: false
```

**Fix 4: 重新生成 patched cli.original.cjs 并验证可运行**

### 2.4 核心原则

所有修复均在**保留全部 24 个破解补丁**的前提下进行。不删除任何功能，只修复导致性能问题的 bug。

---

## 三、破解原理分析

### 3.1 三层引擎架构

**第一层：运行时环境劫持（`cli.cjs`）**

在 `require('./cli.original.cjs')` 之前先执行，通过环境变量劫持运行时行为：

```javascript
// API 路由劫持 + 模型覆盖
process.env.ANTHROPIC_API_KEY = config.apiKey;
process.env.ANTHROPIC_BASE_URL = config.baseURL;
process.env.ANTHROPIC_MODEL = config.model;
process.env.ANTHROPIC_AUTH_TOKEN = config.apiKey;  // 非 Anthropic API 用 Bearer 鉴权

// 特征标志全覆盖
process.env.CLAUDE_INTERNAL_FC_OVERRIDES = features.json;

// 禁用非必要流量
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
process.env.DISABLE_INSTALLATION_CHECKS = '1';
```

**第二层：代码补丁（`patch.mjs`，24个补丁）**

核心技术：通过正则表达式搜索并替换 cli.original.cjs 中的 JavaScript 代码。

**核心破解补丁（第三方模型必需）**：

1. **Auto-mode unlock for third-party API**（L95-99）
   - 删除 `if(type!=="firstParty"&&type!=="anthropicAws")return!1;` 门禁
   - 这是第三方模型最关键的补丁
   
2. **USER_TYPE → "ant"**（L17-21）
   - 把 `return"external"` 改为 `return"ant"` 
   - 影响 GrowthBook 特征标志评估（内部用户看到不同标志）

3. **GrowthBook env overrides**（L22-28）
   - 修改特征标志初始化函数，改为从 `CLAUDE_INTERNAL_FC_OVERRIDES` 环境变量读取 JSON

**功能解锁补丁**：
- Agent Teams、Computer Use、Ultraplan、Ultrareview、Voice Mode

**限制移除补丁**：
- 安全测试拒绝、URL 生成限制、破坏操作确认、登录提示

**视觉补丁**：
- 品牌颜色改为绿色（7 个补丁）

**更新拦截**：
- `claude update` 重定向到 clawgod 自更新

**第三层：安装流程**

```
install.sh → npm 拉取 @anthropic-ai/claude-code-linux-x64
          → extract-natives.mjs 从 222MB ELF 二进制提取 cli.js
          → post-process.mjs 重写 .node 路径 + 包装 IIFE
          → patch.mjs 应用 24 个正则补丁
          → 创建 bash 启动脚本替换 claude 命令
```

### 3.2 双重身份系统

Claude Code 有两个独立的身份系统：

```
vq() 身份（基础设施）：
  默认 "firstParty"（直接使用 Anthropic API）
  通过 env var 可切换为 bedrock/foundry/anthropicAws/mantle/vertex

rP8() 身份（用户等级）：
  补丁前: "external"（外部用户）
  补丁后: "ant"（Anthropic 内部员工）
```

关键发现：`vq()` 默认返回 `"firstParty"`，所以 21 个 `vq()!=="firstParty"` 门禁对第三方用户默认放行。`rP8()` 的 `"ant"` 修改主要影响 GrowthBook 特征标志系统。

### 3.3 安装过程关键数据

- 原生二进制：232MB（ELF 格式）
- 提取的 cli.js：13.84 MB
- 补丁后的 cli.original.cjs：14.5 MB
- 补丁数：24 applied, 2 skipped, 0 failed
- 找到的嵌入 .node 模块：0 个（v2.1.142 格式变化）

---

## 四、子 Agent 不能用的问题分析

### 4.1 问题现象

第三方模型在 ClawGod 破解的 Claude Code 中无法调用子 Agent（Agent Teams 功能）。

### 4.2 分析结论

**不是 clawgod 的补丁问题**——所有代码级别门禁已打通：
- `Agent Teams always enabled` 补丁已应用
- `tengu_amber_flint: true` 标志已设置

根本原因是两层的：

1. **模型默认名不匹配**（主要原因）

子 Agent 的模型解析链：
```
iI7(H) → h$().teammateDefaultModel ?? MJ$()
                                    ↓
                              MY().opus47
                                    ↓
                              "claude-opus-4-7"（硬编码）
```

即使主进程使用第三方模型（如 `deepseek-v4-flash-free`），子 Agent 默认会尝试用 `claude-opus-4-7`，第三方 API 不认识这个模型名。

2. **API 协议差**

子 Agent 通信使用 Anthropic 特有的 API 特性（`anthropic-version: 2023-06-01`、特定 beta header、流式格式），第三方 API 代理可能不支持。

### 4.3 新增补丁：MJ$() 模型继承

针对 `MJ$()` 函数添加新补丁：

```javascript
{
    name: 'Sub-agent model inherit from ANTHROPIC_MODEL',
    // 补丁前: function MJ$(){return MY().opus47}
    // 补丁后: function MJ$(){return process.env.ANTHROPIC_MODEL||MY().opus47}
    // 优先读 ANTHROPIC_MODEL 环境变量
}
```

配合设置 `CLAUDE_CODE_SUBAGENT_MODEL` 环境变量或 `provider.json` 中的 `model` 字段使用。

### 4.4 环境变量传递链

子 Agent 通过 spawn 启动新 `claude` 进程时，环境变量传递机制：
```
cli.cjs 读取 provider.json
  → 设置 process.env.ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY
  → spawn 子进程，继承 ...process.env
  → 子进程 cli.cjs 再次读取 provider.json（双重保障）
  → 子 Agent 代码读取 process.env.ANTHROPIC_MODEL / CLAUDE_CODE_SUBAGENT_MODEL
```

MF_ 传递列表包含 `ANTHROPIC_BASE_URL` 但不包含 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_MODEL`，这些通过 `...process.env` 继承。

---

## 五、Bun 独立可执行文件逆向工具生态

### 5.1 已知工具

| 工具 | 类型 | 对 Claude Code v2.1.142 效果 | 原因 |
|------|------|------------------------------|------|
| ClawGod extract-natives | Node.js | ✅ 成功提取 14MB JS | 用已知锚点搜 IIFE |
| bun-demincer | Node.js | ⚠️ 找到 5 模块但 null byte 导致失败 | 路径名含 `\x00` |
| @shepherdjerred/bun-decompile | npm 包 | ❌ 格式版本不兼容 | pt 计算超出 buffer |
| bun-unpack | Python | ❌ 找不到 module graph | LIEF 解析格式不匹配 |
| unbuned | Python | ❌ 找不到 JS bundle | `// @bun` 标记位置不同 |

### 5.2 StandaloneModuleGraph 格式

二进制文件末尾结构：
```
尾部标记 "\n---- Bun! ----\n"
偏移结构（32 字节，尾部标记前）：
  byte_count: u64 = 130150384
  modules_offset: u32 = 130150123
  modules_length: u32 = 260（= 5 模块 × 52 字节）
  entry_point_id: u32 = 0

数据块：130MB（offset=102424632）
  ├─ 模块条目（260 字节，在数据块末尾）
  ├─ JS IIFE bundle（~14MB，在数据块偏后位置）
  └─ 其他代码分割模块
```

### 5.3 没有找到 sourcemap

`zstd` 魔法字节在 130MB 数据块中出现 0 次。Anthropic 很可能没有用 `--sourcemap` 编译，原始 TypeScript 源码不在二进制中。已经提取的 14MB JS 是 TypeScript 编译后的目标代码，变量名已被混淆。

---

## 六、Tool Search 问题（新增 pY() 补丁）

### 6.1 问题现象

使用第三方 API 时，Tool Search 功能被静默禁用。这导致：
- Skills 无法通过 Tool Search 动态加载
- CLAUDE.md 效果减弱（模型找不到相关 tools）
- 模型自动执行 skills 的积极性降低
- 整体表现为"第三方模型接入后 CLAUDE.md 和 skills 效果变差"

### 6.2 根因分析

**`pY()` 函数**负责判断当前是否在使用 Anthropic 官方 API：

```javascript
function pY(){
  let H = process.env.ANTHROPIC_BASE_URL;
  if(!H) return !0;  // 未设置 → 官方 API
  try {
    let $ = new URL(H).host;
    return ["api.anthropic.com"].includes($)
  } catch {
    return !1
  }
}
```

**Tool Search 启用判断链**（`VP$()` = `isToolSearchEnabled()`）：

```javascript
function VP$(){
  let H = NI6();  // getToolSearchMode()
  if(H === "standard"){ ... return false; }
  // ↓ 这条检查对第三方 API 用户触发 ↓
  if(!process.env.ENABLE_TOOL_SEARCH && vq()==="firstParty" && !pY())
    return false;  // Tool Search 被禁用！
  if(!process.env.ENABLE_TOOL_SEARCH && vq()==="vertex")
    return false;
  ...
  return true;
}
```

当 `ENABLE_TOOL_SEARCH` 未设置 + `vq()==="firstParty"`（默认值）+ `!pY()`（非官方 API）→ **Tool Search 被禁用**。

### 6.3 解决方案

新增补丁：将 `pY()` 直接改为 `return!0`，与 `USER_TYPE="ant"` 思路一致。

```javascript
{
  name: 'Force pY() to always return true (enable Tool Search for 3rd party)',
  // 补丁前: function pY(){let H=...;return["api.anthropic.com"].includes($)}catch{return!1}}
  // 补丁后: function pY(){return!0}
}
```

`pY()` 被 18 处调用，控制着 Tool Search、特性标志、API 路由等功能。改为 `return!0` 后所有功能对第三方 API 用户解锁。

---

## 七、后续新增补丁

### 7.1 NI6() 补丁 — 绕过 Catch-22

```javascript
patch名称: 'Remove DISABLE_EXPERIMENTAL_BETAS gate in NI6()'
问题: 设 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 会禁用 Tool Search（NI6 返回 "standard"）
方案: 移除 NI6() 中的 DISABLE_EXPERIMENTAL_BETAS 检查
补丁前: function NI6(){if(bH(CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS))return"standard";...}
补丁后: function NI6(){.../* 移除了该检查 */}
```

### 7.2 cli.cjs 第三方 API 智能配置

在 `~/.clawgod/cli.cjs` 添加逻辑：当检测到 `baseURL` 非 `anthropic.com` 时自动设置：

```javascript
if (isThirdParty) {
  process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ??= '1';  // 避免 400
  process.env.ENABLE_TOOL_SEARCH ??= 'auto:0';                   // 保持 Tool Search
  process.env.API_TIMEOUT_MS ??= '120000';                       // 合理超时
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS ??= '120000';        // 慢响应不断连
}
```

### 7.3 API 请求层 beta header 全量过滤补丁

```javascript
patch名称: 'Strip all beta headers in messages API when DISABLE_EXPERIMENTAL_BETAS=1'
位置: messages API 的 parse() 方法
补丁前: parse(H,$){return $={...$,headers:Lq([{"anthropic-beta":[...H.betas??[],"structured-outputs-2025-12-15"].toString()},$?.headers])}}
补丁后: parse(H,$){let _betas=process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS?[]:[...H.betas??[],"structured-outputs-2025-12-15"];return $={...$,headers:Lq([{"anthropic-beta":_betas.toString()},$?.headers])}}
```

### 7.4 工具定义字段剥离（已内置，无需补丁）

`lM8()` 函数中已有逻辑：当 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 时，
自动剥离 `input_examples`、`defer_loading`、`eager_input_streaming`、`strict` 等非标准字段，
只保留 `name`、`description`、`input_schema`、`cache_control`。

### 7.5 web_search 对第三方 API 禁用（改用 web_fetch）

**问题**：web_search 是 Anthropic 服务器端工具，第三方 API 没有搜索后端。
当模型调用 web_search 时，第三方 API 返回空结果或 400。

**方案**：两个补丁协同工作——

```javascript
// 补丁 A：mt_() 返回 null（不注册 web_search 工具）
patch名称: 'Disable web_search for third-party API'
补丁前: function mt_(H){return{type:"web_search_20250305",name:"web_search",...}}
补丁后: function mt_(H){
          if(process.env.ANTHROPIC_BASE_URL && !/anthropic\.com/i.test(process.env.ANTHROPIC_BASE_URL))
            return null;  // 第三方 API → 不注册该工具
          return{type:"web_search_20250305",name:"web_search",...}
        }

// 补丁 B：过滤 extraToolSchemas 中的 null
patch名称: 'Filter null from extraToolSchemas'
// r=[...A.extraToolSchemas??[]] → r=[...A.extraToolSchemas??[]].filter(Boolean)
```

**效果**：
- 第三方 API 用户：模型看不到 web_search 工具（sub-request 层和 tool definition 层双重禁用）
- 官方 API 用户：web_search 正常工作（条件判断不触发）

**v2.1.143 新增问题**：仅靠补丁 A+B 不够，因为 `Dq()` 默认返回 `"firstParty"`（没有设置 `CLAUDE_CODE_USE_BEDROCK` 等环境变量时），导致 web_search 的 `isEnabled()` 返回 `true`，该工具定义依然出现在 API 请求中，模型仍会选中它。

```javascript
// 补丁 C：web_search 工具的 isEnabled() 前置 ANTHROPIC_BASE_URL 检测
patch名称: 'Disable WebSearch isEnabled for third-party API'
补丁前: isEnabled(){let H=Dq();if(H==="firstParty"||H==="anthropicAws")return!0;...return!1}
补丁后: isEnabled(){
          if(process.env.ANTHROPIC_BASE_URL && !/anthropic\.com/i.test(process.env.ANTHROPIC_BASE_URL))
            return!1;  // 第三方 API → 工具不可用
          let H=Dq();...
        }
```

**三个补丁的协同关系**：

| 补丁 | 作用层 | 解决的问题 |
|------|--------|-----------|
| A (VH5) | sub-request | web_search 内部子请求禁用服务器端工具 |
| B (extraToolSchemas filter) | API 请求 | 过滤 `extraToolSchemas` 中的 null |
| C (isEnabled) | **工具注册** | 不让模型看到 web_search 工具定义 |

### 7.5 GitHub Issue 分析结果

通过 `github_search_issues` 搜索了 6 组关键词，分析了 ~60 个相关 issue：

**已知问题**：
| # | 标题 | 状态 | 与我们补丁的关系 |
|---|------|------|----------------|
| #56970 | DISABLE_EXPERIMENTAL_BETAS 在 2.1.129+ 失效 | OPEN | beta stripping 补丁覆盖 |
| #53855 | effort-2025-11-24 beta header 仍被发送 | OPEN | beta stripping 补丁覆盖 |
| #11678 | tool input_examples 导致 400 | OPEN | 已内置 field stripping 覆盖 |
| #58284 | Agent View 被 Bedrock/Vertex 硬禁用 | CLOSED | 检查 `yk1()`——与我们无关 |
| #30926 | advanced-tool-use beta → LiteLLM/Bedrock 400 | CLOSED | beta stripping 补丁覆盖 |
| #56595 | 请求体 anthropic_beta 数组导致 400 | CLOSED | beta stripping 补丁覆盖 |
| #32378 | ToolSearch 在 ANTHROPIC_BASE_URL 下被禁 | CLOSED | pY()+NI6() 补丁覆盖 |

**Beta header 演进史**（每个版本加新 beta → 用户报 400 → 修）：

```
v2.1.22  context_management beta → 400
v2.1.23  prompt-caching-scope beta → 400
v2.1.69  advanced-tool-use beta → 400 (LiteLLM/Bedrock)
v2.1.81  structured-outputs beta → 400
v2.1.104 tool-search-tool beta → 400
v2.1.129 interleaved-thinking/extended-cache-ttl beta → 400
v2.1.132 context-1m beta → 400 (OPEN #56970)
```

---

## 八、补丁汇总

截至 2026-05-16（v2.1.143），clawgod 共 **32 个补丁**：

| # | 补丁名 | 类别 |
|---|--------|------|
| 1 | USER_TYPE → ant | 核心破解 |
| 2 | GrowthBook env overrides | 核心破解 |
| 3 | GrowthBook config overrides | 核心破解 |
| 4 | Agent Teams always enabled | 功能解锁 |
| 5 | Computer Use subscription bypass | 功能解锁 |
| 6 | Computer Use default enabled | 功能解锁 |
| 7 | Ultraplan enable | 功能解锁 |
| 8 | Ultrareview enable | 功能解锁 |
| 9 | Computer Use gate bypass | 功能解锁 |
| 10 | Voice Mode enable (bypass GrowthBook kill) | 功能解锁 |
| 11 | Auto-mode unlock for third-party API | 核心破解 |
| 12 | Redirect `claude update` to clawgod self-update | 功能 |
| 13 | Sub-agent model inherit from ANTHROPIC_MODEL | 核心破解 |
| 14 | Force pY()/FYH() to always return true | 核心破解 |
| 15 | Remove DISABLE_EXPERIMENTAL_BETAS gate in NI6()/dI6() | 核心破解 |
| 16 | Strip all beta headers in messages API | 兼容性 |
| 17 | Disable web_search for third-party API (VH5) | 兼容性 |
| 18 | Filter null from extraToolSchemas | 兼容性 |
| 19-25 | 绿色主题补丁（7 个：RGB/ANSI/dark/light/shimmer/hex） | 视觉 |
| 26-29 | 限制移除（4 个：CYBER_RISK/URL/CAUTIOUS/NOT_LOGGED_IN） | 限制移除 |
| 30-31 | 消息过滤（2 个：attachment + s_8 form） | 功能 |
| **32** | **Disable WebSearch isEnabled for third-party API** | **兼容性** |

**cli.cjs 智能配置**（非 patch.mjs 补丁，直接修改包装器）：
- 自动检测第三方 API → 注入 `DISABLE_EXPERIMENTAL_BETAS` + `ENABLE_TOOL_SEARCH` + `API_TIMEOUT_MS` + `STREAM_IDLE_TIMEOUT`

---

## 九、官方更新后重新破解指南

当 Anthropic 发布新版 Claude Code 后：

### 9.1 更新流程

```bash
# 1. 安装新版（install.sh 会自动拉取最新）
bash ~/.clawgod/install.sh

# 2. 或手动安装指定版本
bash ~/.clawgod/install.sh --version 2.1.150

# 3. 查看 CHANGELOG 新特性
# 访问 https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
# 或用 gh 工具：
gh search issues "repo:anthropics/claude-code type:issue label:bug" --limit 20
```

### 9.2 检查补丁是否失效

```bash
# 运行 patch.mjs 的 verify 模式：
node ~/.clawgod/patch.mjs --verify
```

查看哪些补丁显示 `regex stale`（正则失效，需要重新编写）。

### 9.3 重新分析新版代码

```bash
# 1. 从新版二进制提取 JS
node ~/.clawgod/extract-natives.mjs ~/.local/share/claude/versions/X.Y.Z ~/.clawgod --cli-js

# 2. 运行后处理
node ~/.clawgod/post-process.mjs

# 3. 运行补丁
node ~/.clawgod/patch.mjs
```

### 9.4 需重点关注的新变化

每次更新后检查：
1. **CHANGELOG** 中新的 `beta` header 或 `anthropic_beta` 字段 → 可能需要更新 beta stripping 补丁
2. **新的 `tengu_*` 特征标志** → 更新 features.json（2.1.143 已移除 `tengu_amber_quartz_disabled`）
3. **`pY()` / `FYH()` 函数** → 检查 provider gate 是否改名或重构（2.1.143 中 `pY`→`FYH`，Lq→Jq）
4. **`NI6()` / `dI6()` 函数** → 检查 Tool Search 逻辑（2.1.143 中 DISABLE_EXPERIMENTAL_BETAS 门禁已被移除）
5. **新的 `vq()` 判断分支** → 检查是否影响 USER_TYPE
6. **新的工具定义字段** → 检查是否被 `input_examples` 类似问题

### 9.5 实战经验：2.1.142 → 2.1.143 升级

```bash
# 1. 从新版本 ELF 二进制提取 JS
node ~/.clawgod/extract-natives.mjs ~/.local/share/claude/versions/2.1.143 ~/.clawgod --cli-js

# 2. 后处理转为 CJS（需指定输出路径）
node ~/.clawgod/post-process.mjs
# 将生成的 CJS 替换 cli.original.cjs

# 3. Verify 模式检查补丁
node ~/.clawgod/patch.mjs --verify
# 预期：多数显示「not yet applied」，少数显示：
#   「regex stale」→ 正则失效，需要重新编写
#   「sentinel absent」→ 函数已被上游重写/移除

# 4. 修复失效正则
# 常见原因：
#   a) 混淆函数名变化（如 Lq→Jq）→ 正则中改为 `[\w$]+` 通配符
#   b) 函数完全重写（如 NI6→dI6）→ 更新 pattern + sentinel
#   c) 特征 flag 被移除（如 tengu_amber_quartz_disabled）→ 直接跳过

# 5. 应用全部补丁
node ~/.clawgod/patch.mjs
```

### 9.6 2.1.143 关键变化清单

| 变化 | 影响 | 处理方式 |
|------|------|----------|
| `FYH()` 新 gate 函数（`pY()` 改名） | 限制 Tool Search、system prompt、tool filter 到 firstParty | 现有 `pY()` 补丁通配 `([\w$]+)` 自动匹配 |
| `NI6()` → `dI6()`（DISABLE_EXPERIMENTAL_BETAS 移除） | 函数完全重写，门禁已不存在 | 补丁自动标记「已应用」（sentinel 不存在） |
| `Lq` → `Jq`（header-merge 函数改名） | Beta stripping 补丁 regex 失效 | 修复为 `([\w$]+)` 通配匹配 |
| Voice Mode flag 移除 | `tengu_amber_quartz_disabled` 不存在 | 跳过该补丁 |
| 无新反第三方限制 | 除 FYH() 外无新增 gate | 无需新增补丁 |

---

## 十、关键文件路径

| 文件 | 路径 | 说明 |
|------|------|------|
| Claude Code 原生二进制 | `~/.local/share/claude/versions/2.1.143` | 最新支持版本 |
| ClawGod 安装目录 | `~/.clawgod/` | 运行时目录 |
| 启动包装器 | `~/.clawgod/cli.cjs` | 智能配置 + 第三方 API 优化 |
| 补丁后的源码 | `~/.clawgod/cli.original.cjs` | 已打补丁（14.5MB，不纳入 git） |
| 补丁前的备份 | `~/.clawgod/cli.original.cjs.bak` | 用于 diff repatch |
| 补丁脚本 | `~/.clawgod/patch.mjs` | **31 个补丁** |
| 版本戳 | `~/.clawgod/.source-version` | 当前版本 `2.1.143` |
| 后处理脚本 | `~/.clawgod/post-process.mjs` | ESM→CJS + try/catch 修复 |
| 特征标志 | `~/.clawgod/features.json` | GrowthBook overrides |
| 提供者配置 | `~/.clawgod/provider.json` | 第三方 API 模板 |
| Native 模块提取 | `~/.clawgod/extract-natives.mjs` | Bun SEA 提取 |
| 重打补丁助手 | `~/.clawgod/repatch.mjs` | diff-based repatch |
| 源码仓库 | `/home/aaa/develop/clawgod/` | git 仓库（dev 分支） |

---

## 十一、dev 分支开发与版本兼容性

### 11.1 分支策略

```
dev（我们的开发）
  ↑ merge
main（追踪 0Chencc/clawgod 上游）
  ↑ fetch
chencc/main（原作者 0Chencc）
```

| 分支 | 追踪 | 用途 |
|------|------|------|
| `main` | `origin/main` (gdlwolf) | 接收上游更新后合并到 dev |
| `dev` | 无（默认分支） | 所有二开 + 修复 |
| `chencc/main` | `0Chencc/clawgod` | 上游参考，cherry-pick 有用 commit |

### 11.2 同步上游工作流

```bash
# 原作者更新了
git checkout main
git pull origin main                  # gdlwolf 的 main（fork 同步后）
# 或直接从 chencc 拉
git fetch chencc
git checkout main && git merge chencc/main

# 合并到 dev
git checkout dev
git merge main
git push origin dev
```

### 11.3 版本升级检查清单

每次新版 Claude Code 发布后的验证步骤：

1. **提取 JS** → `extract-natives.mjs` + `post-process.mjs`
2. **Verify 补丁** → `node patch.mjs --verify`
3. **修复 regex stale** → 常见原因：混淆名变化、函数重写、flag 移除
4. **审查新 gate** → 搜索 `!== "firstParty"`、`Dq() ==`、`ENABLE_TOOL_SEARCH` 等关键词
5. **应用+冒烟** → `node patch.mjs` + `claude --help`
6. **更新 wiki** → 记录关键变化到本文件 + `log.md`

### 11.4 所有 commit 历史（dev 分支）

```
718c353 docs: add CHANGELOG.md following Anthropic convention
be87bc3 chore: replace all 0Chencc/clawgod references with gdlwolf/clawgod
d73eb79 feat(dev): init dev branch with 31 patches, LLM wiki, and third-party enhancements
d73a48a fix(patcher): Auto-mode unlock regex fails on claude 2.1.139 (multi-var let) [cherry-pick chencc]
f05db83 Merge pull request #70 from keyblues/fix/windows-launcher-encoding [cherry-pick chencc]
8687867 fix(installer): require path separator boundary in USERPROFILE prefix check [cherry-pick chencc]
1a25162 fix(installer): resolve garbled characters in .cmd launcher for non-ASCII Windows usernames [cherry-pick chencc]
25e5315 fix(installer): hard-require Bun >= 1.3.14 with pre-flight version gate [upstream]
b5306eb docs: add Star History section to all READMEs [upstream]
... (更早的上游 commit)
```
