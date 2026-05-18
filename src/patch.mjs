#!/usr/bin/env node
/**
 * ClawGod Universal Patcher — 正则模式匹配, 跨版本兼容
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = join(__dirname, 'cli.original.cjs');
const BACKUP = TARGET + '.bak';

// ─── Regex-based patches (version-agnostic) ──────────────

const patches = [
  {
    name: 'USER_TYPE → ant',
    pattern: /function ([\w$]+)\(\)\{return"external"\}/g,
    replacer: (m, fn) => `function ${fn}(){return"ant"}`,
    sentinel: 'return"external"',
  },
  {
    name: 'GrowthBook env overrides',
    pattern: /function ([\w$]+)\(\)\{if\(!([\w$]+)\)\2=!0;return ([\w$]+)\}/g,
    replacer: (m, fn, flag, val) =>
      `function ${fn}(){if(!${flag}){${flag}=!0;try{let e=process.env.CLAUDE_INTERNAL_FC_OVERRIDES;if(e)${val}=JSON.parse(e)}catch(e){}}return ${val}}`,
    sentinel: ')Gq6=!0;return zTK}',  // unpatched form (v2.1.143 minified names)
    unique: true,  // must match exactly 1
  },
  {
    name: 'GrowthBook config overrides',
    pattern: /function ([\w$]+)\(\)\{return\}(function)/g,
    replacer: (m, fn, next) =>
      `function ${fn}(){try{return j8().growthBookOverrides??null}catch{return null}}${next}`,
    selectIndex: 0,  // first match only (there may be others)
    validate: (match, code) => {
      // Must be near other GrowthBook functions
      const pos = code.indexOf(match);
      const nearby = code.substring(Math.max(0, pos - 500), pos + 500);
      return nearby.includes('growthBook') || nearby.includes('GrowthBook') || nearby.includes('FeatureValue');
    },
    sentinel: 'growthBookOverrides',  // present after patching, absent in unpatched
    sentinelAbsence: true,  // sentinel absence means "not yet applied"
  },
  {
    name: 'Agent Teams always enabled',
    pattern: /function ([\w$]+)\(\)\{if\(![\w$]+\(process\.env\.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\)&&![\w$]+\(\)\)return!1;if\(![\w$]+\("tengu_amber_flint",!0\)\)return!1;return!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    sentinel: '"tengu_amber_flint",!0))return!1;return!0}',
  },
  {
    // ≤v2.1.142: function X(){let H=Y();return H==="max"||H==="pro"}
    // v2.1.143+: function Du(){if(Sdq!==null)return Sdq;if(!Hq())return!1;let H=z4();if(H==="max"||H==="pro")return!0;...}
    //   The v2.1.143 version already has caching and additional org role checks.
    //   We need to match both shapes and make the function return true.
    name: 'Computer Use subscription bypass',
    pattern: /function ([\w$]+)\(\)\{let [\w$]+=[\w$]+\(\);return [\w$]+==="max"\|\|[\w$]+==="pro"\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    optional: true,  // v2.1.143+ has a different function shape (auto-bypasses via Hq() returning true)
  },
  {
    name: 'Computer Use default enabled',
    pattern: /([\w$]+=)\{enabled:!1,pixelValidation/g,
    replacer: (m, prefix) => `${prefix}{enabled:!0,pixelValidation`,
    sentinel: '{enabled:!1,pixelValidation',
  },
  {
    // v2.1.92+ shape: name:"ultraplan",get description(){...},argumentHint:"<prompt>",isEnabled:()=>fnRef()
    // Older shape  : name:"ultraplan",description:`...`,argumentHint:"<prompt>",isEnabled:()=>!1
    // Patched shape: name:"ultraplan",...,isEnabled:()=>!0
    // Match all three so already-patched code reports "no change needed".
    name: 'Ultraplan enable',
    pattern: /(name:"ultraplan",[\s\S]{1,500}?argumentHint:"<prompt>",isEnabled:\(\)=>)(?:!0|!1|[\w$]+\(\))/g,
    replacer: (m, prefix) => `${prefix}!0`,
  },
  {
    // ≤v2.1.110: function X(){return Y("tengu_review_bughunter_config",null)?.enabled===!0}
    // v2.1.119+: function X(){return Y("tengu_review_bughunter_config",null)} — getter
    //            and the gate at function Z(){return X()?.enabled===!0} elsewhere.
    //            We override the getter to always return {enabled:!0}.
    name: 'Ultrareview enable',
    pattern: /function ([\w$]+)\(\)\{return [\w$]+\("tengu_review_bughunter_config",null\)(\?\.enabled===!0)?\}/g,
    replacer: (m, fn) => `function ${fn}(){return{enabled:!0}}`,
    sentinel: '"tengu_review_bughunter_config"',
  },
  {
    name: 'Computer Use gate bypass',
    pattern: /function ([\w$]+)\(\)\{return [\w$]+\(\)&&[\w$]+\(\)\.enabled\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    optional: true,  // may not exist in all versions
  },
  {
    name: 'Voice Mode enable (bypass GrowthBook kill)',
    pattern: /function ([\w$]+)\(\)\{return![\w$]+\("tengu_amber_quartz_disabled",!1\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    optional: true,  // removed in v2.1.143+
  },
  {
    // ≤v2.1.110: let Y=Dq();if(Y!=="firstParty"&&Y!=="anthropicAws")return!1;return/^claude-(opus|sonnet)-4-6/.test(K)
    // v2.1.119+: same gate plus extra branches for claude-opus-4-7.
    // v2.1.139+: gate moved inside function wuH(H){let $=R7(H),q=Wq();if(q!=="firstParty"&&q!=="anthropicAws")return!1;if($.includes("claude-3-")||...)return!0;return!1}
    //            i.e. the `let` lifted to a comma-list before the if; the if-gate
    //            itself is unchanged shape. We drop only the if-gate; downstream
    //            model allow-list still runs and now accepts third-party calls.
    name: 'Auto-mode unlock for third-party API',
    pattern: /if\(([\w$]+)!=="firstParty"&&\1!=="anthropicAws"\)return!1;/g,
    replacer: () => '',
    sentinel: '!=="firstParty"&&',
  },
  {
    // CLI subcommand registered via commander chain:
    //   .command("update").alias("upgrade").description("…").action(async()=>{…})
    // The original action's update path is broken under clawgod: detectInstallType()
    // returns "unknown" because the launcher hides our cli.cjs from upstream's
    // path heuristics, and the unknown-fallback branch on macOS overwrites
    // ~/.bun/bin/bun by extracting the bun runtime out of the new native binary
    // (preserving Apr-19-build mtime). That **silently downgrades** clawgod's
    // required Bun and crashes cli.original.cjs the next launch with
    // "Expected CommonJS module to have a function wrapper". On Windows the
    // same fallback writes the new binary somewhere our drift detection
    // doesn't scan, so the user sees "Successfully updated" but never gets
    // the new version.
    //
    // Redirect to clawgod's own self-update so the upgrade goes through
    // install.sh (re-extract + re-patch + re-launcher). Always pull the
    // latest install.sh from the release so users get patcher fixes too.
    // Escape hatch printed on every run: `install.sh --uninstall` restores
    // claude.orig and lets vanilla `claude update` work again.
    name: "Redirect `claude update` to clawgod self-update",
    pattern: /(\.command\("update"\)\.alias\("upgrade"\)\.description\("[^"]+"\)\.action\(async\(\)=>\{)/g,
    replacer: (m, prefix) => {
      // PowerShell 5.1's Invoke-WebRequest ignores HTTP_PROXY/HTTPS_PROXY env
      // (only reads IE system proxy). Read env explicitly and pass via -Proxy
      // so it works on both PS 5.1 and PS 7. Use Invoke-RestMethod (irm) not
      // Invoke-WebRequest (iwr): under -UseBasicParsing on PS 5.1, iwr's
      // .Content is byte[] not string, so `iex (iwr -useb ...).Content`
      // throws "Cannot convert System.Byte[] to System.String". irm always
      // returns string in both versions. -EncodedCommand bypasses CLI
      // arg-quoting; payload must be UTF-16LE base64.
      const psScript =
        "$p=if($env:HTTPS_PROXY){$env:HTTPS_PROXY}elseif($env:HTTP_PROXY){$env:HTTP_PROXY}else{$null};" +
        "$u='https://raw.githubusercontent.com/gdlwolf/clawgod/main/install.ps1';" +
        "if($p){iex(irm -Proxy $p $u)}else{iex(irm $u)}";
      const psB64 = Buffer.from(psScript, 'utf16le').toString('base64');
      return (
        prefix +
        `process.stderr.write("[clawgod] 'claude update' is handled by clawgod self-update.\\n[clawgod] To leave clawgod and use vanilla update: bash ~/.clawgod/install.sh --uninstall\\n[clawgod] Continuing now\\u2026\\n");` +
        `var __cgW=process.platform==='win32';` +
        `var __cgCmd=__cgW?['powershell','-NoProfile','-EncodedCommand','${psB64}']:['bash','-c','curl -fsSL https://raw.githubusercontent.com/gdlwolf/clawgod/main/install.sh | bash'];` +
        `var __cgRes=require('child_process').spawnSync(__cgCmd[0],__cgCmd.slice(1),{stdio:'inherit'});` +
        `process.exit(__cgRes.status||0);`
      );
    },
    sentinel: '.command("update").alias("upgrade")',
  },
  // ── 模型默认值重定向 ──
  // Sub-agent 默认使用 MJ$() → MY().opus47（硬编码 claude-opus-4-7）
  // 第三方 API 用户需要子 Agent 继承主模型，改为优先读 ANTHROPIC_MODEL env var
  {
    name: 'Sub-agent model inherit from ANTHROPIC_MODEL',
    pattern: /function ([\w$]+)\(\)\{return MY\(\)\.(\w+)\}/g,
    replacer: (m, fn, modelKey) => `function ${fn}(){return process.env.ANTHROPIC_MODEL||MY().${modelKey}}`,
    selectIndex: 0,
    optional: true,
    sentinel: 'return MY().',
  },

  // ── 第三方 API 的 Tool Search 和特性启用 ──
  // pY() 检查 ANTHROPIC_BASE_URL 是否是 api.anthropic.com。
  // 第三方 API 用户 → pY()=false → Tool Search 被禁用 → skills/tools 无法动态加载
  // 改为始终返回 true，和 USER_TYPE="ant" 思想一致"假装在用官方 API"
  {
    name: 'Force pY() to always return true (enable Tool Search for 3rd party)',
    pattern: /function ([\w$]+)\(\)\{let H=process\.env\.ANTHROPIC_BASE_URL;if\(!H\)return!0;try\{let \$=new URL\(H\)\.host;return\["api\.anthropic\.com"\]\.includes\(\$\)\}catch\{return!1\}\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    sentinel: 'ANTHROPIC_BASE_URL;if(!H)return!0;try{let $=new URL(H).host;return["api.anthropic.com"].includes($)}',
  },

  // ── ST() gate bypass for third-party API ──
  // v2.1.143: function ST(){return w86()} where w86() checks Dq()==="firstParty"/"anthropicAws"/"foundry".
  // We make ST() return true so features gated behind ST() (advisor, prompt caching, etc.)
  // work for third-party API users too.
  // Older v2.1.142 shape: function X(){return Y()&&!CH(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)}
  // — matched by the old regex. v2.1.143 removed the DISABLE_EXPERIMENTAL_BETAS check.
  {
    name: 'Bypass ST() firstParty gate (enable features for 3rd party)',
    pattern: /function ST\(\)\{return [\w$]+\(\)\}/g,
    replacer: () => 'function ST(){return!0}',
    sentinel: 'function ST(){return w86()}',
  },
  // ── cI6()/dI6() Tool Search mode — remove DISABLE_EXPERIMENTAL_BETAS gate ──
  // v2.1.142: function cI6(){if(CH(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS))return"standard";let H=...}
  // v2.1.143: function dI6(){let H=process.env.ENABLE_TOOL_SEARCH;if(!H)return gI6;if(H==="auto")return gI6;let $=K$4(H);if($!==null)return $;return gI6}
  //   — DISABLE_EXPERIMENTAL_BETAS gate removed by upstream; function simplified.
  //   dI6() now returns a numeric percentage (gI6), not "standard"/"tst"/"tst-auto" strings.
  //   No patch needed for v2.1.143+.
  {
    name: 'Remove DISABLE_EXPERIMENTAL_BETAS gate in cI6()/dI6() (enable Tool Search for 3rd party)',
    pattern: /function ([\w$]+)\(\)\{if\(CH\(process\.env\.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS\)\)return"standard";let H=process\.env\.ENABLE_TOOL_SEARCH,\$=H\?([\w$]+)\(H\):null;if\(\$===0\)return"tst";if\(\$===100\)return"standard";if\(([\w$]+)\(H\)\)return"tst-auto";if\(CH\(H\)\)return"tst";if\(([\w$]+)\(process\.env\.ENABLE_TOOL_SEARCH\)\)return"standard";return"tst"\}/g,
    replacer: (m, fn, fnK, fnt15, fnI4) => `function ${fn}(){let H=process.env.ENABLE_TOOL_SEARCH,$=H?${fnK}(H):null;if($===0)return"tst";if($===100)return"standard";if(${fnt15}(H))return"tst-auto";if(CH(H))return"tst";if(${fnI4}(process.env.ENABLE_TOOL_SEARCH))return"standard";return"tst"}`,
    sentinel: 'DISABLE_EXPERIMENTAL_BETAS))return"standard";let H=process.env.ENABLE_TOOL_SEARCH',
    optional: true,  // v2.1.143+ removed this gate entirely
  },

  // ── NI6() Tool Search mode — remove DISABLE_EXPERIMENTAL_BETAS gate ──
  // v2.1.110 shape: function NI6(){if(bH(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS))return"standard";...}
  // v2.1.143: upstream removed DISABLE_EXPERIMENTAL_BETAS from this function entirely.
  //   dI6() now returns a numeric percentage (gI6 variable), not "standard"/"tst" strings.
  //   No patch needed for v2.1.143+, but keep the pattern for older versions.
  {
    name: 'Remove DISABLE_EXPERIMENTAL_BETAS gate in NI6() (keep Tool Search enabled)',
    pattern: /function ([\w$]+)\(\)\{if\(bH\(process\.env\.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS\)\)return"standard";let H=process\.env\.ENABLE_TOOL_SEARCH,\$=H\?WH4\(H\):null;if\(\$===0\)return"tst";if\(\$===100\)return"standard";if\(O95\(H\)\)return"tst-auto";if\(bH\(H\)\)return"tst";if\(E4\(process\.env\.ENABLE_TOOL_SEARCH\)\)return"standard";return"tst"\}/g,
    replacer: (m, fn) => `function ${fn}(){let H=process.env.ENABLE_TOOL_SEARCH,$=H?WH4(H):null;if($===0)return"tst";if($===100)return"standard";if(O95(H))return"tst-auto";if(bH(H))return"tst";if(E4(process.env.ENABLE_TOOL_SEARCH))return"standard";return"tst"}`,
    sentinel: 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS))return"standard";let H=process.env.ENABLE_TOOL_SEARCH,$=H?WH4(H):null',
    optional: true,  // v2.1.143+ removed this gate entirely
  },

  // ── API 请求层全量 beta 过滤 ──
  // 在 messages API 的 parse() 方法中，当 DISABLE_EXPERIMENTAL_BETAS=1 时，
  // 清空所有 anthropic-beta header，避免第三方 API 不认识的 beta 导致 400。
  // 同时也会阻止 beta 泄漏到请求体的 anthropic_beta 数组。
  {
    // Minified header-merge function name (Lq→Jq→etc) changes per build.
    // Match any valid JS identifier via capture group.
    name: 'Strip all beta headers in messages API when DISABLE_EXPERIMENTAL_BETAS=1',
    pattern: /parse\(H,\$\)\{return \$=\{\.\.\.\$,headers:([\w$]+)\(\[\{"anthropic-beta":\[\.\.\.H\.betas\?\?\[\],"structured-outputs-2025-12-15"\]\.toString\(\)\},\$\?\.headers\]\)\},this\.create\(H,\$\)\.then\(/g,
    replacer: (m, fn) => `parse(H,$){let _betas=process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS?[]:[...H.betas??[],"structured-outputs-2025-12-15"];return $={...$,headers:${fn}([{"anthropic-beta":_betas.toString()},$?.headers])},this.create(H,$).then(`,
    sentinel: 'structured-outputs-2025-12-15"].toString()},$?.headers])},this.create(H,$).then(',
  },

  // ── web_search 对第三方 API 禁用 → 改用 web_fetch ──
  // web_search 是 Anthropic 服务器端工具，第三方 API 没有搜索后端。
  // 当检测到第三方 API 时，让 mt_() 返回 null（不注册该工具），
  // 同时确保 extraToolSchemas 中的 null 被过滤掉。
  {
    name: 'Disable web_search for third-party API',
    // Pattern uses [\w$]+ instead of mt_ to survive minifier renames across versions.
    // Sentinel checks for the unpatched form (function returning the object directly,
    // without the third-party guard). The patched form has an if-guard before return,
    // so this sentinel won't match after patching — correctly marking it "already applied".
    pattern: /function ([\w$]+)\(H\)\{return\{type:"web_search_20250305",name:"web_search",allowed_domains:H\.allowed_domains,blocked_domains:H\.blocked_domains,max_uses:8\}\}/g,
    replacer: (m, fn) => `function ${fn}(H){if(process.env.ANTHROPIC_BASE_URL&&!/anthropic\\.com/i.test(process.env.ANTHROPIC_BASE_URL))return null;return{type:"web_search_20250305",name:"web_search",allowed_domains:H.allowed_domains,blocked_domains:H.blocked_domains,max_uses:8}}`,
    // Sentinel: the unpatched form starts with `(H){return{type:"web_search_20250305"...`.
    // After patching, it becomes `(H){if(process.env.ANTHROPIC_BASE_URL...return null;return{...}}`,
    // so this sentinel won't match — correctly detecting "already applied".
    sentinel: '(H){return{type:"web_search_20250305"',
  },
  {
    name: 'Filter null from extraToolSchemas',
    pattern: /r=\[\.\.\.A\.extraToolSchemas\?\?\[\]\]/g,
    replacer: () => 'r=[...A.extraToolSchemas??[]].filter(Boolean)',
    sentinel: 'r=[...A.extraToolSchemas??[]];',
  },

  // ── 绿色主题 (patch 标识) ──
  // Green theme patches change brand colors. After patching, the original
  // color strings are replaced, so sentinels detect the unpatched form.

  {
    name: 'Logo + brand color → green (RGB dark)',
    pattern: /clawd_body:"rgb\(215,119,87\)"/g,
    replacer: () => 'clawd_body:"rgb(34,197,94)"',
    sentinel: 'clawd_body:"rgb(215,119,87)"',
  },
  {
    name: 'Logo + brand color → green (ANSI)',
    pattern: /clawd_body:"ansi:redBright"/g,
    replacer: () => 'clawd_body:"ansi:greenBright"',
    sentinel: 'clawd_body:"ansi:redBright"',
  },
  {
    name: 'Theme claude color → green (dark)',
    pattern: /claude:"rgb\(215,119,87\)"/g,
    replacer: () => 'claude:"rgb(34,197,94)"',
    sentinel: 'claude:"rgb(215,119,87)"',
  },
  {
    name: 'Theme claude color → green (light)',
    pattern: /claude:"rgb\(255,153,51\)"/g,
    replacer: () => 'claude:"rgb(22,163,74)"',
    sentinel: 'claude:"rgb(255,153,51)"',
  },
  {
    name: 'Shimmer → green',
    // v2.1.142: rgb(235,159,127) or rgb(245,149,117)
    // Both are orange/warm shimmer colors — replace with green
    pattern: /claudeShimmer:"rgb\(2[34]5,1[45]9,1[12]7\)"/g,
    replacer: () => 'claudeShimmer:"rgb(74,222,128)"',
    sentinel: 'claudeShimmer:"rgb(235,',
  },
  {
    name: 'Shimmer light → green',
    pattern: /claudeShimmer:"rgb\(255,183,101\)"/g,
    replacer: () => 'claudeShimmer:"rgb(34,197,94)"',
    sentinel: 'claudeShimmer:"rgb(255,183',
  },
  {
    name: 'Hex brand color → green',
    pattern: /#da7756/g,
    replacer: () => '#22c55e',
    sentinel: '#da7756',
  },

  // ── 限制移除 ──

  {
    name: 'Remove CYBER_RISK_INSTRUCTION',
    pattern: /([\w$]+)="IMPORTANT: Assist with authorized security testing[^"]*"/g,
    replacer: (m, varName) => `${varName}=""`,
    sentinel: 'Assist with authorized security testing',
  },
  {
    name: 'Remove URL generation restriction',
    pattern: /\n\$\{[\w$]+\}\nIMPORTANT: You must NEVER generate or guess URLs[^.]*\. You may use URLs provided by the user in their messages or local files\./g,
    replacer: () => '',
    sentinel: 'IMPORTANT: You must NEVER generate or guess URLs',
  },
  {
    name: 'Remove cautious actions section',
    // v2.1.88-~v2.1.122: function GSY(){return`# Executing actions...`}
    // v2.1.123+: function _j3(H){if(LE8(H)==="compact")return`# Executing...short`;return`# Executing...long`}
    pattern: /function ([\w$]+)\(([\w$]*)\)\{(?:if\([\s\S]{1,200}?\)return`# Executing actions with care\n\n[\s\S]*?`;)?return`# Executing actions with care\n\n[\s\S]*?`\}/g,
    replacer: (m, fn, arg) => `function ${fn}(${arg}){return\`\`}`,
    sentinel: '# Executing actions with care',
  },
  {
    name: 'Remove "Not logged in" notice',
    pattern: /Not logged in\. Run [\w ]+ to authenticate\./g,
    replacer: () => '',
    optional: true,
  },

  // ── 消息过滤 ──

  {
    // v2.1.88-~v2.1.91: fn()!=="ant"){if(q.attachment.type==="hook_additional_context"...
    // v2.1.92+        : fn()!=="ant"&&paY.has(q.attachment.type) — paY is an empty Set
    //                    in v2.1.110, so this filter is effectively a no-op; patch anyway
    //                    to guard against paY being populated in future versions.
    name: 'Attachment filter bypass',
    pattern: /([\w$]+)\(\)!=="ant"(&&[\w$]+\.has\([\w$]+\.attachment\.type\)|\)\{if\([\w$]+\.attachment\.type==="hook_additional_context")/g,
    replacer: (m) => m.replace(/([\w$]+)\(\)!=="ant"/, 'false'),
    optional: true,  // filter may be removed entirely in future versions
  },
  {
    // Legacy (≤v2.1.91) ternary form: fn()!=="ant"?tRY(_,sRY(K)):K
    name: 'Message list filter bypass (legacy ternary)',
    pattern: /([\w$]+)\(\)!=="ant"\?([\w$]+)\(([\w$]+),([\w$]+)\(([\w$]+)\)\):([\w$]+)/g,
    replacer: (m, fn, tRY, underscore, sRY, K, fallback) => fallback,
    optional: true,  // removed in v2.1.92+
  },
  {
    // v2.1.92+ (s_8): if(fn()==="ant")return _;let z=...;return FaY(_,z)
    // Flip the guard so non-ant users also return the pre-filtered list.
    name: 'Message list filter bypass (s_8 form)',
    pattern: /if\(([\w$]+)\(\)==="ant"\)return ([\w$]+);let ([\w$]+)=([\w$]+) instanceof Set\?\4:([\w$]+)\(\4\);return ([\w$]+)\(\2,\3\)/g,
    replacer: (m, fn, ret) => `return ${ret}`,
    optional: true,  // legacy versions had a ternary instead
  },

  // ── WebSearch isEnabled() — 第三方 API 禁用 ──
  // Dq()/vq() 默认返回 "firstParty"（因为没有环境变量），
  // 导致 WebSearch 工具的 isEnabled() 返回 true，
  // 模型看到 web_search 工具定义 → 优先使用内置搜索而非 Tavily MCP。
  // 在 isEnabled() 开头添加 ANTHROPIC_BASE_URL 第三方检测，
  // 和 VH5() 中的检测逻辑保持一致（patch #20）。
  {
    name: 'Disable WebSearch isEnabled for third-party API',
    pattern: /isEnabled\(\)\{let H=([\w$]+)\(\);if\(H==="firstParty"\|\|H==="anthropicAws"\)return!0;if\(H==="gateway"\)return!1/g,
    replacer: (m, name) => `isEnabled(){if(process.env.ANTHROPIC_BASE_URL&&!/anthropic\\.com/i.test(process.env.ANTHROPIC_BASE_URL))return!1;let H=${name}();if(H==="firstParty"||H==="anthropicAws")return!0;if(H==="gateway")return!1`,
    sentinel: '!=="firstParty"&&!/anthropic',
    validate: (match, code) => {
      // Must be the WebSearch tool's isEnabled (with vertex/foundry fallthrough)
      const pos = code.indexOf(match);
      const lookahead = code.substring(pos + match.length, pos + match.length + 200);
      return lookahead.includes('vertex') && lookahead.includes('foundry');
    },
  },
  // ── 禁用第三方 API 的 outputFormat json_schema ──
  // Stop/SubagentStop hook evaluator 使用 outputFormat:{type:"json_schema"}
  // 强制模型返回严格 JSON。第三方 API 不认识此特性，忽略或错误处理，
  // 导致 q7(sx(response)) → null → "JSON validation failed"。
  // U2H() 决定模型是否支持 outputFormat，第三方 API 时让 U2H 返回 false，
  // mp5() 就不会注入 outputFormat。hook evaluator 的 prompt 中已包含
  // JSON 返回格式说明，模型仍会返回可解析的 JSON。
  {
    name: 'Disable outputFormat json_schema for third-party API',
    pattern: /function ([\w$]+)\(H\)\{let \$=[\w$]+\(H\),q=[\w$]+\(H\);if\(![\w$]+\(q\)\|\|q==="gateway"\)return!1;if\(\$\.includes\("claude-3-"\)\|\|\$==="claude-opus-4-0"\|\|\$==="claude-sonnet-4-0"\)return!1;return!0\}/g,
    replacer: (m, fn) => m.replace(`function ${fn}(H){`, `function ${fn}(H){if(process.env.ANTHROPIC_BASE_URL&&!/anthropic\\.com/i.test(process.env.ANTHROPIC_BASE_URL))return!1;`),
    sentinel: 'ANTHROPIC_BASE_URL&&!/anthropic\\.com/i.test(process.env.ANTHROPIC_BASE_URL))return!1;let $',
    sentinelAbsence: true,  // sentinel presence = already patched
  },

  // ── 解锁第三方 API 的 Auto-Memory ──
  // ui$() (v2.1.143, was Pi$()) 是 auto-memory 系统的关键门禁函数：
  //   1. Z$("tengu_sepia_cormorant",null) → 如果 null（默认），返回 false
  //   2. 否则 iTK(modelName, allowlist) → 检查当前模型名是否在白名单中
  //   3. Z$("tengu_umber_petrel",!1) → 最终开关，默认 false
  // 第三方模型名不在 Anthropic 白名单 → ui$() 返回 false → x9() 关闭 auto-memory。
  // 补丁：让 ui$() 直接返回 true，auto-memory 对所有模型启用。
  // 注意：minifier 混淆名可能跨版本变化（v2.1.142: Pi$, v2.1.143: ui$），
  //   所以 pattern 使用 [\\w$]+ 通配符匹配函数名。
  {
    name: 'Enable auto-memory for third-party API (bypass model allowlist gate)',
    pattern: /function ([\w$]+)\(\)\{let H=[\w$]+\("tengu_sepia_cormorant",null\);if\(!Array\.isArray\(H\)\|\|H\.length===0\)return!1;let \$=[\w$]+\(\),q=\$!==void 0\?\$:[\w$]+\(\);if\(typeof q!=="string"\|\|![\w$]+\(q,H\)\)return!1;return [\w$]+\("tengu_umber_petrel",!1\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    sentinel: 'tengu_sepia_cormorant",null);if(!Array.isArray(H)',
  },

  // ── 解锁 memorySelector（auto-memory 内容注入）──
  // oo7() 是 memorySelector 函数，在用户输入时触发记忆搜索：
  //   条件：!K (no selector) || $.agentId (subagent) || !x9() (auto off) || !Z$("tengu_moth_copse",!1)
  //   最后一个条件：tengu_moth_copse 默认 false → 记忆内容指南不注入
  // 补丁：将 Z$("tengu_moth_copse",!1) 条件在 o7() 中始终为 true。
  // 注意：此补丁不易通过正则定位 oo7() 的具体调用，
  //   因此改用 features.json 设置 tengu_moth_copse: true。
  // 但 o7() 中的 !Z$("tengu_moth_copse",!1) 在 Z$() 的 default 为 !1，
  //   如果 GrowthBook 未提供该 flag，Z$() 返回 !1 → oo7() 提前 return。
  // 需要在 features.json 中添加 tengu_moth_copse: true。
  // 此处不加代码补丁，而是依赖 features.json 覆盖。

  // ── Fast Mode 解锁 — 第三方 API 用户无法使用 Fast Mode ──
  // Y9() (v2.1.143 minified name, was _9()) 是 Fast Mode 的启用检查：
  //   function Y9(){if(Dq()!=="firstParty")return!1;return!CH(process.env.CLAUDE_CODE_DISABLE_FAST_MODE)}
  //   Dq() 默认返回 "firstParty"（无 Bedrock/Vertex 环境变量时），
  //   但 pY() 被我们改为 return!0 后，某些代码路径中 Dq() 可能被重新评估。
  //   直接让 Y9() 去掉 vq()/Dq() 检查，使 Fast Mode 对所有用户可用。
  //   保留 DISABLE_FAST_MODE 环境变量的控制。
  {
    name: 'Enable Fast Mode for third-party API',
    pattern: /function ([\w$]+)\(\)\{if\(([\w$]+)\(\)!=="firstParty"\)return!1;return!([\w$]+)\(process\.env\.CLAUDE_CODE_DISABLE_FAST_MODE\)\}/g,
    replacer: (m, fn, vqfn, bhfn) => `function ${fn}(){return!${bhfn}(process.env.CLAUDE_CODE_DISABLE_FAST_MODE)}`,
    sentinel: '!=="firstParty")return!1;return!',  // sentinel is the removed vq check
  },

  // ── Advisor 工具解锁 — 第三方 API 用户无法使用 Advisor ──
  // uC() 是 Advisor 工具的启用检查：
  //   function uC(){if(bH(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL))return!1;if(vq()!=="firstParty"||!RT())return!1;...}
  //   RT() 已被 ST() bypass 补丁覆盖（返回 true），但 vq()!=="firstParty" 仍阻止第三方用户。
  //   移除 vq()!=="firstParty" 检查，同时保留 DISABLE_ADVISOR_TOOL 和 GrowthBook 控制。
  {
    name: 'Enable Advisor tool for third-party API',
    pattern: /if\(bH\(process\.env\.CLAUDE_CODE_DISABLE_ADVISOR_TOOL\)\)return!1;if\(vq\(\)!=="firstParty"\|\|!([\w$]+)\(\)\)return!1;/g,
    replacer: (m, fn) => 'if(bH(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL))return!1;',
    sentinel: 'DISABLE_ADVISOR_TOOL))return!1;if(vq()!=="firstParty"',
  },

  // ── Image Size Limit 提升 — 第三方 API 限制 5MB → 10MB ──
  // ac1() 决定图片大小限制：
  //   function ac1(){if(vq()==="firstParty"&&pY()&&Z$("tengu_crimson_vector",!1))return SxK;return Ql.maxBase64Size}
  //   只有 firstParty+pY()+tengu_crimson_vector 才返回 SxK(10MB)，否则 5MB。
  //   pY() 已补丁为 true，但 vq()==="firstParty" 对第三方 API 用户仍需通过。
  //   让第三方 API 用户也享受 10MB 限制。
  {
    name: 'Unlock 10MB image size limit for third-party API',
    pattern: /function ([\w$]+)\(\)\{if\(vq\(\)==="firstParty"&&([\w$]+)\(\)&&Z\$\("tengu_crimson_vector",!1\)\)return ([\w$]+);return ([\w$]+)\.maxBase64Size\}/g,
    replacer: (m, fn, pYfn, sxk, ql) => `function ${fn}(){if(${pYfn}()&&Z$("tengu_crimson_vector",!1))return ${sxk};return ${ql}.maxBase64Size}`,
    sentinel: 'vq()==="firstParty"&&',
  },

  // ── Send User File 工具解锁 — 第三方 API 用户无法发送文件给模型 ──
  // isEnabled(){if(vq()!=="firstParty"||f4())return!1;if(!Z$("tengu_send_user_file",!0))return!1;...}
  //   移除 vq()!=="firstParty" 检查。
  {
    name: 'Enable Send User File tool for third-party API',
    pattern: /isEnabled\(\)\{if\(vq\(\)!=="firstParty"\|\|([\w$]+)\(\)\)return!1;if\(!Z\$\("tengu_send_user_file",!0\)\)return!1;/g,
    replacer: (m, fn) => 'isEnabled(){if(!Z$("tengu_send_user_file",!0))return!1;',
    sentinel: 'vq()!=="firstParty"||',
    validate: (match, code) => code.indexOf('tengu_send_user_file') !== -1,
  },

  // ── 上下文窗口限制解除 — 第三方 API 默认 200k → 1M ──
  // EP(H,$) 返回模型上下文窗口大小：
  //   function EP(H,$){
  //     if(CH(DISABLE_COMPACT)&&process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS){...return K}
  //     if(lG(H))return 1e6;        // [1m] 标签
  //     if($?.includes(xU.header)&&Fc(H))return 1e6;  // beta header + model 检查
  //     if(OqH(H))return 1e6;        // opus-4-7
  //     let q=Zl$(H);if(q!==null)return q;  // kelp_forest_sonnet 缓存
  //     return M86                 // 默认 200000
  //   }
  //   对第三方模型（如 GLM-5.1），[1m] 标签不存在，beta header 也没有，
  //   最终返回 M86=200000。这导致：
  //   1. 自动压缩在 ~167k tokens 时触发（应该 980k）
  //   2. 上下文窗口显示错误（200k 而非 1M）
  //   3. 在第三方 API 下无法充分利用 1M 上下文
  //   修复：将 M86 默认值从 200000 改为 1000000
  {
    name: 'Raise default context window from 200k to 1M for third-party models',
    pattern: /var M86=200000/g,
    replacer: (m) => 'var M86=1000000',
    sentinel: 'var M86=200000',
  },

  // ── CLAUDE_CODE_MAX_CONTEXT_TOKENS 环境变量解锁 ──
  // EP 函数要求同时设置 DISABLE_COMPACT 才能使用 MAX_CONTEXT_TOKENS，
  // 这意味着用户要么禁用自动压缩，要么无法自定义上下文大小。
  // 修复：移除 DISABLE_COMPACT 前置条件，允许用户独立指定上下文大小。
  {
    name: 'Allow CLAUDE_CODE_MAX_CONTEXT_TOKENS without DISABLE_COMPACT',
    pattern: /if\([\w$]+\(process\.env\.DISABLE_COMPACT\)&&process\.env\.CLAUDE_CODE_MAX_CONTEXT_TOKENS\)\{/g,
    replacer: (m) => 'if(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS){',
    sentinel: 'DISABLE_COMPACT)&&process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  },

  // ── 1h Cache TTL 解锁 — 第三方 API 默认只有 5 分钟缓存 ──
  // ivH() 决定缓存 TTL 是否为 1h：
  //   function ivH(H){
  //     if(bH(FORCE_PROMPT_CACHING_5M))return!1;
  //     if(bH(ENABLE_PROMPT_CACHING_1H))return!0;    // 环境变量可以强制
  //     if(vq()==="bedrock"&&bH(ENABLE_PROMPT_CACHING_1H_BEDROCK))return!0;
  //     if(!qq()||bZ.isUsingOverage)return!1;          // ← 第三方被拦截
  //     let $=nv8();if($===null)$=Z$("tengu_prompt_cache_1h_config",{...}).allowlist;
  //     ...
  //   }
  //   qq() 检查 OAuth 认证状态，使用 ANTHROPIC_API_KEY 的第三方用户
  //   没有通过 OAuth 认证，导致 qq()=false，ivH() 返回 false。
  //   结果：第三方 API 只有 5 分钟缓存 TTL，而不是 1 小时。
  //   修复：跳过 qq() 和 isUsingOverage 的检查，让 GrowthBook flag 接管。
  {
    name: 'Unlock 1h cache TTL for third-party API (bypass auth gate)',
    pattern: /if\(!qq\(\)\|\|[\w$]+\.isUsingOverage\)return!1;/g,
    replacer: (m) => '/* patched: bypass auth check for 1h cache */if(!1)return!1;',
    sentinel: '!qq()||bZ.isUsingOverage)return!1;',
    validate: (match, code) => {
      // Only apply if this appears near tengu_prompt_cache_1h_config
      const idx = code.indexOf(match[0]);
      const nearby = code.substring(Math.max(0, idx - 300), idx + 300);
      return nearby.includes('tengu_prompt_cache_1h_config');
    },
  },

  // ── Global Cache Scope 解锁 — 第三方 API 缓存不跨会话共享 ──
  // FYH()（v2.1.142 为 SYH）决定缓存 scope 是否为 global：
  //   function FYH(){
  //     if(!ST())return!1;    // 实验性 beta（已补丁为 true）
  //     if(!xz())return!1;    // 已补丁为 true
  //     let H=Dq();return H==="firstParty"||H==="anthropicAws"  // ← 第三方被拦截
  //   }
  //   第三方 API 的 Dq()!=="firstParty" → FYH()=false → scope=undefined（本地缓存）
  //   结果：缓存只在当前请求内有效，不会跨会话持久化。
  //   修复：让 FYH() 对第三方模型也返回 true，启用 global scope。
  {
    name: 'Unlock global cache scope for third-party API',
    pattern: /function ([\w$]+)\(\)\{if\(!([\w$]+)\(\)\)return!1;if\(!([\w$]+)\(\)\)return!1;let H=([\w$]+)\(\);return H==="firstParty"\|\|H==="anthropicAws"\}/g,
    replacer: (m, fn, rt, xz, dq) => `function ${fn}(){if(!${rt}())return!1;if(!${xz}())return!1;return!0}`,
    sentinel: 'H==="firstParty"||H==="anthropicAws"}',
  },
// ── Auto Mode (AFK Detection) 解锁 ──
  // $i() 是 auto-mode 启用检查：
  //   function $i(){
  //     if(rQ!==void 0)return rQ;
  //     if(v6H())return rQ=Ha(!0);           // GrowthBook feature flag
  //     if(Dq()==="gateway")return rQ=Ha(!0); // gateway 始终启用
  //     if(Dq()!=="firstParty")return rQ=Ha(!1);  ← 第三方被拦截
  //     if(!xz())return rQ=Ha(!1);           // 已补丁为 true
  //     if(process.env.CLAUDE_CODE_ENTRYPOINT==="local-agent")return rQ=Ha(!1);
  //     let H=xq();...OAuth/subscription checks...
  //   }
  //   第三方 API 即使 Dq() 返回 "firstParty"，后续的 OAuth/subscription
  //   检查仍然会阻止没有 OAuth token 的 API key 用户。
  //   补丁：移除 firstParty 检查、xz 检查（已补丁为true）和 local-agent 检查。
  {
    name: 'Unlock Auto Mode for third-party API',
    pattern: /if\([\w$]+\(\)!=="firstParty"\)return rQ=Ha\(!1\);if\(!xz\(\)\)return rQ=Ha\(!1\);if\(process\.env\.CLAUDE_CODE_ENTRYPOINT==="local-agent"\)return rQ=Ha\(!1\)/g,
    replacer: (m) => 'if(!xz())return rQ=Ha(!1)',
    sentinel: 'firstParty")return rQ=Ha(!1)',
    validate: (match, code) => {
      const pos = code.indexOf(match);
      const nearby = code.substring(Math.max(0, pos - 100), pos + 100);
      return nearby.includes('rQ!==') || nearby.includes('v6H');
    },
  },

  // ── Channels 功能解锁 ──
  // qrH() 在 channels 注册时检查 provider：
  //   if(Dq()!=="firstParty")return{action:"skip",kind:"provider",
  //     reason:"channels are not available on third-party providers"}
  //   第三方 API 用户无法使用 MCP channels 功能。
  //   补丁：移除 firstParty 检查，允许第三方 API 使用 channels。
  {
    name: 'Unlock Channels for third-party API',
    pattern: /if\([\w$]+\(\)!=="firstParty"\)return\{action:"skip",kind:"provider",reason:"channels are not available on third-party providers"\}/g,
    replacer: (m) => '',
    sentinel: 'channels are not available on third-party providers',
  },

  // ── Model Migration 解锁 ──
  // Xe4() (legacy opus) 和 Ne4() (sonnet 4.5→4.6)
  // 都以 if(vq()!=="firstParty")return 开头，
  // 导致第三方 API 用户无法自动升级旧版模型设置。
  // 补丁：移除这两个函数的 firstParty 检查。
  // 使用 validate 区分 Opus 和 Sonnet 迁移函数。
  {
    name: 'Unlock legacy Opus model migration for third-party API',
    pattern: /function [\w$]+\(\)\{if\([\w$]+\(\)!=="firstParty"\)return;/g,
    replacer: (m) => m.replace(/if\([\w$]+\(\)!=="firstParty"\)return;/, ''),
    sentinel: '"claude-opus-4"',  // sentinel for opus migration context
    validate: (match, code) => {
      const pos = code.indexOf(match);
      const nearby = code.substring(pos, pos + 500);
      return nearby.includes('claude-opus-4');
    },
  },
  {
    name: 'Unlock Sonnet 4.5→4.6 migration for third-party API',
    pattern: /function [\w$]+\(\)\{if\([\w$]+\(\)!=="firstParty"\)return;/g,
    replacer: (m) => m.replace(/if\([\w$]+\(\)!=="firstParty"\)return;/, ''),
    sentinel: '"claude-sonnet-4-5"',  // sentinel for sonnet migration context
    validate: (match, code) => {
      const pos = code.indexOf(match);
      const nearby = code.substring(pos, pos + 500);
      return nearby.includes('claude-sonnet-4-5');
    },
  },
];

// ─── Main ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const revert = args.includes('--revert');

if (revert) {
  if (!existsSync(BACKUP)) { console.error('❌ No backup found'); process.exit(1); }
  copyFileSync(BACKUP, TARGET);
  console.log('✅ Reverted from backup');
  process.exit(0);
}

if (!existsSync(TARGET)) {
  console.error('❌ Target not found:', TARGET);
  process.exit(1);
}

let code = readFileSync(TARGET, 'utf8');
const origSize = code.length;

// Extract version
const verMatch = code.match(/Version:\s*([\d.]+)/);
const version = verMatch ? verMatch[1] : 'unknown';

console.log(`\n${'═'.repeat(55)}`);
console.log(`  ClawGod (universal)`);
console.log(`  Target: cli.original.cjs (v${version})`);
console.log(`  Mode: ${dryRun ? 'DRY RUN' : verify ? 'VERIFY' : 'APPLY'}`);
console.log(`${'═'.repeat(55)}\n`);

let applied = 0, skipped = 0, failed = 0;

for (const p of patches) {
  const matches = [...code.matchAll(p.pattern)];
  let relevant = matches;

  // Filter by validation if provided
  if (p.validate) {
    relevant = matches.filter(m => p.validate(m[0], code));
  }

  // Select specific match index
  if (p.selectIndex !== undefined) {
    relevant = relevant.length > p.selectIndex ? [relevant[p.selectIndex]] : [];
  }

  // Uniqueness check — skip when 0 so the sentinel / already-applied
  // fallthrough can handle it; only fail on >1 (ambiguous).
  if (p.unique && relevant.length > 1) {
    console.log(`  ⚠️  ${p.name} — ${relevant.length} matches, skipping (need 1)`);
    failed++;
    continue;
  }

  if (relevant.length === 0) {
    if (p.optional) {
      console.log(`  ⏭  ${p.name} (not present in this version)`);
      skipped++;
      continue;
    }
    // If the patch declares a sentinel (a string that must NOT exist in a
    // fully-patched file), use it to tell "already applied" apart from
    // "regex is stale and silently missed the target".
    if (p.sentinel !== undefined) {
      const sentinels = Array.isArray(p.sentinel) ? p.sentinel : [p.sentinel];
      const stillPresent = sentinels.filter((s) => code.includes(s));
      if (p.sentinelAbsence) {
        // sentinelAbsence: sentinel PRESENT means "already applied" (opposite of default)
        // e.g., "growthBookOverrides" only appears after patching
        if (stillPresent.length === sentinels.length) {
          console.log(`  ✅ ${p.name} (already applied, sentinel present)`);
          applied++;
        } else {
          console.log(`  ⚠️  ${p.name} (0 matches, sentinel absent — cannot verify)`);
          skipped++;
        }
      } else if (stillPresent.length > 0) {
        console.log(`  ❌ ${p.name} — regex stale, sentinel still in source: ${stillPresent.map((s) => JSON.stringify(s)).join(', ')}`);
        failed++;
      } else {
        console.log(`  ✅ ${p.name} (already applied, sentinel absent)`);
        applied++;
      }
      continue;
    }
    console.log(`  ⚠️  ${p.name} (0 matches, no sentinel — cannot verify)`);
    skipped++;
    continue;
  }

  if (verify) {
    console.log(`  ⬚  ${p.name} — ${relevant.length} match(es), not yet applied`);
    skipped++;
    continue;
  }

  // Apply patch
  let count = 0;
  for (const m of relevant) {
    const replacement = p.replacer(m[0], ...m.slice(1));
    if (replacement !== m[0]) {
      if (!dryRun) {
        code = code.replace(m[0], replacement);
      }
      count++;
    }
  }

  if (count > 0) {
    console.log(`  ✅ ${p.name} (${count} replacement${count > 1 ? 's' : ''})`);
    applied++;
  } else {
    console.log(`  ⏭  ${p.name} (no change needed)`);
    skipped++;
  }
}

console.log(`\n${'─'.repeat(55)}`);
console.log(`  Result: ${applied} applied, ${skipped} skipped, ${failed} failed`);

if (!dryRun && !verify && applied > 0) {
  if (!existsSync(BACKUP)) {
    copyFileSync(TARGET, BACKUP);
    console.log(`  📦 Backup: ${BACKUP}`);
  }
  writeFileSync(TARGET, code, 'utf8');
  const diff = code.length - origSize;
  console.log(`  📝 Written: cli.original.cjs (${diff >= 0 ? '+' : ''}${diff} bytes)`);
}

console.log(`${'═'.repeat(55)}\n`);
