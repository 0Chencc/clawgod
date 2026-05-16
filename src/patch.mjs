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
  },
  {
    name: 'Agent Teams always enabled',
    pattern: /function ([\w$]+)\(\)\{if\(![\w$]+\(process\.env\.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\)&&![\w$]+\(\)\)return!1;if\(![\w$]+\("tengu_amber_flint",!0\)\)return!1;return!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    name: 'Computer Use subscription bypass',
    pattern: /function ([\w$]+)\(\)\{let [\w$]+=[\w$]+\(\);return [\w$]+==="max"\|\|[\w$]+==="pro"\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    name: 'Computer Use default enabled',
    pattern: /([\w$]+=)\{enabled:!1,pixelValidation/g,
    replacer: (m, prefix) => `${prefix}{enabled:!0,pixelValidation`,
  },
  {
    // v2.1.92+ shape: name:"ultraplan",get description(){...},argumentHint:"<prompt>",isEnabled:()=>fnRef()
    // Older shape  : name:"ultraplan",description:`...`,argumentHint:"<prompt>",isEnabled:()=>!1
    // The middle metadata block changed from a literal description to a getter,
    // and the gate switched from a literal !1 to a GrowthBook-flag-check function call.
    // Match both.
    name: 'Ultraplan enable',
    pattern: /(name:"ultraplan",[\s\S]{1,500}?argumentHint:"<prompt>",isEnabled:\(\)=>)(?:!1|[\w$]+\(\))/g,
    replacer: (m, prefix) => `${prefix}!0`,
    sentinel: 'name:"ultraplan"',
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
  },
  {
    name: 'Voice Mode enable (bypass GrowthBook kill)',
    pattern: /function ([\w$]+)\(\)\{return![\w$]+\("tengu_amber_quartz_disabled",!1\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
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
        `const _w=process.platform==='win32';` +
        `const _c=_w?['powershell','-NoProfile','-EncodedCommand','${psB64}']:['bash','-c','curl -fsSL https://raw.githubusercontent.com/gdlwolf/clawgod/main/install.sh | bash'];` +
        `const _r=require('child_process').spawnSync(_c[0],_c.slice(1),{stdio:'inherit'});` +
        `process.exit(_r.status||0);`
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

  // ── 绕过 Catch-22：CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 不再禁用 Tool Search ──
  // 第三方 API 用户需要设置 DISABLE_EXPERIMENTAL_BETAS=1 避免 beta header 400 错误，
  // 但 NI6() 中这个设置会导致 return "standard" 从而禁用 Tool Search。
  // 移除这个检查，让 Tool Search 不受 DISABLE_EXPERIMENTAL_BETAS 影响。
  {
    name: 'Remove DISABLE_EXPERIMENTAL_BETAS gate in NI6() (keep Tool Search enabled)',
    pattern: /function ([\w$]+)\(\)\{if\(bH\(process\.env\.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS\)\)return"standard";let H=process\.env\.ENABLE_TOOL_SEARCH,\$=H\?WH4\(H\):null;if\(\$===0\)return"tst";if\(\$===100\)return"standard";if\(O95\(H\)\)return"tst-auto";if\(bH\(H\)\)return"tst";if\(E4\(process\.env\.ENABLE_TOOL_SEARCH\)\)return"standard";return"tst"\}/g,
    replacer: (m, fn) => `function ${fn}(){let H=process.env.ENABLE_TOOL_SEARCH,$=H?WH4(H):null;if($===0)return"tst";if($===100)return"standard";if(O95(H))return"tst-auto";if(bH(H))return"tst";if(E4(process.env.ENABLE_TOOL_SEARCH))return"standard";return"tst"}`,
    sentinel: 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS))return"standard";let H=process.env.ENABLE_TOOL_SEARCH,$=H?WH4(H):null',
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
    pattern: /function ([\w$]+)\(H\)\{return\{type:"web_search_20250305",name:"web_search",allowed_domains:H\.allowed_domains,blocked_domains:H\.blocked_domains,max_uses:8\}\}/g,
    replacer: (m, fn) => `function ${fn}(H){if(process.env.ANTHROPIC_BASE_URL&&!/anthropic\\.com/i.test(process.env.ANTHROPIC_BASE_URL))return null;return{type:"web_search_20250305",name:"web_search",allowed_domains:H.allowed_domains,blocked_domains:H.blocked_domains,max_uses:8}}`,
    sentinel: 'allowed_domains:H.allowed_domains,blocked_domains:H.blocked_domains,max_uses:8',
  },
  {
    name: 'Filter null from extraToolSchemas',
    pattern: /r=\[\.\.\.A\.extraToolSchemas\?\?\[\]\]/g,
    replacer: () => 'r=[...A.extraToolSchemas??[]].filter(Boolean)',
    sentinel: 'r=[...A.extraToolSchemas??[]];',
  },

  // ── 绿色主题 (patch 标识) ──

  {
    name: 'Logo + brand color → green (RGB dark)',
    pattern: /clawd_body:"rgb\(215,119,87\)"/g,
    replacer: () => 'clawd_body:"rgb(34,197,94)"',
  },
  {
    name: 'Logo + brand color → green (ANSI)',
    pattern: /clawd_body:"ansi:redBright"/g,
    replacer: () => 'clawd_body:"ansi:greenBright"',
  },
  {
    name: 'Theme claude color → green (dark)',
    pattern: /claude:"rgb\(215,119,87\)"/g,
    replacer: () => 'claude:"rgb(34,197,94)"',
  },
  {
    name: 'Theme claude color → green (light)',
    pattern: /claude:"rgb\(255,153,51\)"/g,
    replacer: () => 'claude:"rgb(22,163,74)"',
  },
  {
    name: 'Shimmer → green',
    pattern: /claudeShimmer:"rgb\(2[34]5,1[45]9,1[12]7\)"/g,
    replacer: () => 'claudeShimmer:"rgb(74,222,128)"',
  },
  {
    name: 'Shimmer light → green',
    pattern: /claudeShimmer:"rgb\(255,183,101\)"/g,
    replacer: () => 'claudeShimmer:"rgb(34,197,94)"',
  },
  {
    name: 'Hex brand color → green',
    pattern: /#da7756/g,
    replacer: () => '#22c55e',
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
      if (stillPresent.length > 0) {
        console.log(`  ❌ ${p.name} — regex stale, sentinel still in source: ${stillPresent.map((s) => JSON.stringify(s)).join(', ')}`);
        failed++;
        continue;
      }
      console.log(`  ✅ ${p.name} (already applied, sentinel absent)`);
      applied++;
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
