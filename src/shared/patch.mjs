#!/usr/bin/env node
/**
 * ClawGod Universal Patcher — 正则模式匹配, 跨版本兼容
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = join(__dirname, 'cli.original.cjs');
const BACKUP = TARGET + '.bak';

// ─── Feature registry (toggle units) ─────────────────────
// A feature is the user-facing unit toggled via ~/.clawgod/patches.json
// ({"<featureId>": false}) or per-launch CLAWGOD_FEATURE_<NAME> env overrides
// ("feature=false,other=true"). One feature is usually realized by
// SEVERAL cooperating patches (Computer Use = subscription + default +
// gate); cross-version regex variants are separate patch ids under the
// same feature. A patch id listed in two features applies while ANY of
// them is enabled — disabling one feature never breaks the other.
//
// Patch classification (validated below, mismatch fails the run):
//   toggleable: true  → gated by feature toggles; its id MUST be
//                       referenced by at least one FEATURES entry
//   no toggleable     → core, always applied, NOT referenceable
//
// The patcher itself NEVER reads patches.json — every patch bakes in
// unconditionally. Feature config is loaded at claude launch (wrapper
// reads patches.json + CLAWGOD_FEATURE_* env) and decides the ON/OFF of each
// baked-in gate via globalThis.__clawgodPatches (patch id → bool, computed
// by feature-gates.cjs before cli.original.cjs loads). Every toggleable
// replacer below therefore emits a runtime check of its own patch id:
//   globalThis.__clawgodPatches?.["<patchId>"] !== false
// Absent table (old wrapper, or gates failed to load) → undefined !== false
// → gate passes → same behavior as before toggles existed.

const FEATURES = {
  'agent-teams':    { desc: 'Agent Teams always enabled',
                      patchIds: ['agent-teams', 'agent-teams-graph'] },
  'computer-use':   { desc: 'Computer Use unlock',
                      patchIds: ['computer-use-sub', 'computer-use-default', 'computer-use-gate'] },
  'ultraplan':      { desc: 'Ultraplan slash command',
                      patchIds: ['ultraplan'] },
  'ultrareview':    { desc: 'Ultrareview slash command',
                      patchIds: ['ultrareview-gate', 'ultrareview-direct'] },
  'voice-mode':     { desc: 'Voice Mode',
                      patchIds: ['voice-mode'] },
  'auto-mode':      { desc: 'Auto-mode model selection on third-party APIs',
                      patchIds: ['auto-mode-helper-gate', 'auto-mode-inline-gate'] },
  'classifier-tuning': { desc: 'Auto-mode classifier overrides (timeout/model/retries env vars)',
                      patchIds: ['classifier-timeout', 'classifier-model', 'classifier-retries'] },
  'theme':          { desc: 'Green brand/logo color scheme',
                      patchIds: [
                        'theme-logo-rgb', 'theme-logo-ansi',
                        'theme-claude-rgb-dark', 'theme-claude-rgb-light', 'theme-claude-ansi',
                        'theme-shimmer-rgb', 'theme-shimmer-rgb-light', 'theme-shimmer-ansi',
                        'theme-hex',
                        'theme-brief-rgb-dark', 'theme-brief-rgb-light', 'theme-brief-ansi',
                      ] },
  'geo-neutralize': { desc: 'Neutralize geo/proxy steganography in system prompt',
                      patchIds: ['geo-stego-date', 'geo-detect-probe', 'geo-apostrophe-stego'] },
  'cyber-risk':     { desc: 'Remove CYBER_RISK_INSTRUCTION from system prompt',
                      patchIds: ['remove-cyber-risk'] },
  'url-restriction':{ desc: 'Remove URL generation restriction from system prompt',
                      patchIds: ['remove-url-restriction'] },
  'cautious-actions':{ desc: 'Remove "Executing actions with care" section from system prompt',
                      patchIds: ['remove-cautious-actions'] },
  'not-logged-in':  { desc: 'Remove "Not logged in" notice',
                      patchIds: ['remove-not-logged-in'] },
  'message-filter': { desc: 'Bypass non-ant message/attachment filters',
                      patchIds: ['attachment-filter-bypass', 'message-filter-legacy', 'message-filter-s8'] },
};

// Runtime gate expression baked into every toggleable replacer. Evaluates
// to true unless feature-gates.cjs explicitly computed false for this id.
const gate = (id) => `globalThis.__clawgodPatches?.[${JSON.stringify(id)}]!==!1`;

// ─── Regex-based patches (version-agnostic) ──────────────

const patches = [
  {
    id: 'user-type-ant',
    name: 'USER_TYPE → ant',
    pattern: /function ([\w$]+)\(\)\{return"external"\}/g,
    replacer: (m, fn) => `function ${fn}(){return"ant"}`,
    sentinel: 'return"external"',
  },
  {
    // Bun.isStandaloneExecutable is false under clawgod (plain Bun runtime,
    // not a compiled standalone binary). fv() guards daemon/fork spawn logic
    // (DLt), multitool dispatch (RS), and several other codepaths that need
    // to behave as if running the native binary. The property is frozen on
    // Bun 1.4+ (configurable:false, writable:false), so runtime monkey-patch
    // is impossible — patch the source instead. See issue #133.
    //
    // v2.1.236+ wraps the guard in a typeof-Bun check:
    //   function fv(){return Bun.isStandaloneExecutable===!0}        ≤v2.1.235
    //   function kw(){return typeof Bun<"u"&&Bun.isStandaloneExecutable===!0}  v2.1.236+
    // Match both via an optional `typeof Bun<"u"&&` prefix.
    id: 'bun-standalone-executable',
    name: 'Bun.isStandaloneExecutable → true',
    pattern: /function ([\w$]+)\(\)\{return (?:typeof Bun<"u"&&)?Bun\.isStandaloneExecutable===!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    id: 'growthbook-env-overrides',
    name: 'GrowthBook env overrides',
    pattern: /function ([\w$]+)\(\)\{if\(!([\w$]+)\)=!0;return ([\w$]+)\}/g,
    replacer: (m, fn, flag, val) =>
      `function ${fn}(){if(!${flag}){${flag}=!0;try{let e=process.env.CLAUDE_INTERNAL_FC_OVERRIDES;if(e)${val}=JSON.parse(e)}catch(e){}}return ${val}}`,
    unique: true,  // must match exactly 1
  },
  {
    // v2.1.245+ moved env-override parsing into a GrowthBook class method and
    // introduced a dead-code bug: the lazy parse short-circuits on the second
    // return, so features.json (CLAUDE_INTERNAL_FC_OVERRIDES) never reaches the
    // feature store — tengu_prompt_cache_1h_config & friends silently lose effect.
    //
    // v2.1.246 shape (chunk graph, _668.js):
    //   getEnvironmentOverrides(){if(this.environmentOverridesParsed)return this.environmentOverrides;return this.environmentOverridesParsed=!0,this.environmentOverrides;let e=this.deps.readEnvironmentOverrides();if(!e)return this.environmentOverrides;try{this.environmentOverrides=Ce(e),p(`GrowthBook: Using env var overrides for ${...}`)}catch{p(`GrowthBook: Failed to parse CLAUDE_INTERNAL_FC_OVERRIDES: ${e}`,...)}return this.environmentOverrides}
    // Patch removes the short-circuit second return so the body reaches the
    // env-var read. Cross-version: match the lazy-parse idiom (flag=!0,value).
    id: 'growthbook-env-overrides-graph',
    name: 'GrowthBook env overrides (graph dead-code fix)',
    pattern: /return this\.environmentOverridesParsed=!0,this\.environmentOverrides;(?=let e=this\.deps\.readEnvironmentOverrides\(\);)/g,
    replacer: () => '',
    sentinel: 'environmentOverridesParsed=!0,this.environmentOverrides',
    optional: true,
  },
  {
    id: 'growthbook-config-overrides',
    name: 'GrowthBook config overrides',
    pattern: /function ([\w$]+)\(\)\{return\}(function)/g,
    replacer: (m, fn, next) =>
      `function ${fn}(){return null}${next}`,
    selectIndex: 0,
    validate: (match, code) => {
      const pos = code.indexOf(match);
      const nearby = code.substring(Math.max(0, pos - 500), pos + 500);
      return nearby.includes('growthBook') || nearby.includes('GrowthBook') || nearby.includes('FeatureValue');
    },
  },
  {
    id: 'agent-teams',
    toggleable: true,
    name: 'Agent Teams always enabled',
    pattern: /function ([\w$]+)\(\)\{if\(![\w$]+\(process\.env\.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\)&&![\w$]+\(\)\)return!1;if\(![\w$]+\("tengu_amber_flint",!0\)\)return!1;return!0\}/g,
    replacer: (m, fn) => `function ${fn}(){if(${gate('agent-teams')})return!0;` + m.slice(`function ${fn}(){`.length, -1) + `}`,
  },
  {
    // v2.1.245+ Agent Teams gate became an exported module in its own chunk
    // with differently-minified identifiers. Shape (v2.1.246,_445.js):
    //   function i(){return process.argv.includes("--agent-teams")}
    //   function s(){if(!e.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS&&!i())return!1;if(!t("tengu_amber_flint",!0))return!1;return!0}
    // Match the flag-gate by the tengu_amber_flint + return!1 shape, tolerant
    // of the identifier set and the argv helper.
    id: 'agent-teams-graph',
    toggleable: true,
    name: 'Agent Teams always enabled (graph)',
    pattern: /function ([\w$]+)\(\)\{if\(![\w$]+\.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS&&![\w$]+\(\)\)return!1;if\(![\w$]+\("tengu_amber_flint",!0\)\)return!1;return!0\}/g,
    replacer: (m, fn) => `function ${fn}(){if(${gate('agent-teams-graph')})return!0;` + m.slice(`function ${fn}(){`.length, -1) + `}`,
    optional: true,
  },
  {
    id: 'computer-use-sub',
    toggleable: true,
    name: 'Computer Use subscription bypass',
    pattern: /function ([\w$]+)\(\)\{let [\w$]+=[\w$]+\(\);return [\w$]+==="max"\|\|[\w$]+==="pro"\}/g,
    replacer: (m, fn) => `function ${fn}(){if(${gate('computer-use-sub')})return!0;` + m.slice(`function ${fn}(){`.length, -1) + `}`,
  },
  {
    id: 'computer-use-default',
    toggleable: true,
    name: 'Computer Use default enabled',
    pattern: /([\w$]+=)\{enabled:!1,pixelValidation/g,
    replacer: (m, prefix) => `${prefix}{enabled:${gate('computer-use-default')}?!0:!1,pixelValidation`,
  },
  {
    // v2.1.92+ shape: name:"ultraplan",get description(){...},argumentHint:"<prompt>",isEnabled:()=>fnRef()
    // Older shape  : name:"ultraplan",description:`...`,argumentHint:"<prompt>",isEnabled:()=>!1
    // The middle metadata block changed from a literal description to a getter,
    // and the gate switched from a literal !1 to a GrowthBook-flag-check function call.
    // Match both.
    id: 'ultraplan',
    toggleable: true,
    name: 'Ultraplan enable',
    pattern: /(name:"ultraplan",[\s\S]{1,500}?argumentHint:"<prompt>",isEnabled:\(\)=>)(!1|[\w$]+\(\))/g,
    replacer: (m, prefix, orig) => `${prefix}(${gate('ultraplan')}?!0:${orig})`,
    sentinel: 'name:"ultraplan"',
  },
  {
    // ≤v2.1.110: function X(){return Y("tengu_review_bughunter_config",null)?.enabled===!0}
    // v2.1.119+: function X(){return Y("tengu_review_bughunter_config",null)} — bare getter
    // v2.1.152+: same bare-getter shape, config also feeds cost_note/duration_note/model
    // v2.1.214+: config key moved to a variable:
    //   var Yau="tengu_review_bughunter_config";
    //   function Fot(){return et(Yau,null)}
    //   function rQt(){return Fot()?.enabled===!0&&ru()&&!J6()}
    //   Patch rQt to always return true so ultrareview is unlocked.
    //   Also match the old direct-literal form for <=2.1.213 compat.
    id: 'ultrareview-gate',
    toggleable: true,
    name: 'Ultrareview enable (rQt gate)',
    pattern: /function ([\w$]+)\(\)\{return ([\w$]+)\(\)\?\.enabled===!0&&[\w$]+\(\)&&![\w$]+\(\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return ${gate('ultrareview-gate')}?!0:(${m.slice(`function ${fn}(){return `.length, -1)})}`,
    optional: true,
  },
  {
    id: 'ultrareview-direct',
    toggleable: true,
    name: 'Ultrareview enable (direct literal, <=2.1.213)',
    pattern: /function ([\w$]+)\(\)\{return ([\w$]+)\("tengu_review_bughunter_config",null\)(\?\.enabled===!0)?\}/g,
    replacer: (m, fn, getter, hasGate) =>
      hasGate
        ? `function ${fn}(){if(${gate('ultrareview-direct')})return!0;` + m.slice(`function ${fn}(){`.length, -1) + `}`
        : `function ${fn}(){let _r=${getter}("tengu_review_bughunter_config",null);return ${gate('ultrareview-direct')}?_r?{..._r,enabled:!0}:{enabled:!0}:_r}`,
    optional: true,
  },
  {
    id: 'computer-use-gate',
    toggleable: true,
    name: 'Computer Use gate bypass',
    pattern: /function ([\w$]+)\(\)\{return [\w$]+\(\)&&[\w$]+\(\)\.enabled\}/g,
    replacer: (m, fn) => `function ${fn}(){return ${gate('computer-use-gate')}?!0:(${m.slice(`function ${fn}(){return `.length, -1)})}`,
  },
  {
    id: 'voice-mode',
    toggleable: true,
    name: 'Voice Mode enable (bypass GrowthBook kill)',
    pattern: /function ([\w$]+)\(\)\{return![\w$]+\("tengu_amber_quartz_disabled",!1\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return ${gate('voice-mode')}?!0:(${m.slice(`function ${fn}(){return`.length, -1)})}`,
  },
  {
    // Auto-mode classifier stage1 (xml_s1) deadline formula (v2.1.251+):
    //   function d7t(e){let n=Math.max(0,Math.ceil((e-50000)/50000));return Math.min(YY,eQe+n*1e4)}
    // eQe=60000 base, YY=120000 cap (identifiers drift). Patch:
    // CLAWGOD_CLASSIFIER_TIMEOUT_MS is a floor — result becomes
    // max(original formula, override). Original token scaling is kept, but
    // the override is never shrunk below the formula and defeats the 120s
    // cap when larger. The floor is read in the injected code: it is gated by
    // this patch's own gate and reads the env at call time (so settings.json
    // `env`, applied post-init by applyConfigEnvironmentVariables, also
    // reaches it), then feeds the raw value to the pure value parser
    // globalThis.__clawgodHelpers.classifierTimeoutFloor (runtime-helpers.cjs).
    // The helper returns the finite number or null for
    // missing/blank/non-numeric/Infinity. The injected code checks for null
    // explicitly: null (or gate off) keeps the original formula, while any
    // real number — including a legitimate "0" — flows into Math.max as a
    // real floor. No 0 sentinel: 0 is never used to mean "no override".
    // __clawgodHelpers is guaranteed to be set (cli.cjs requires
    // runtime-helpers.cjs at launch), so we access it directly — no optional
    // chaining.
    id: 'classifier-timeout',
    toggleable: true,
    name: 'Auto-mode classifier timeout override (CLAWGOD_CLASSIFIER_TIMEOUT_MS)',
    pattern: /function ([\w$]+)\(([\w$]+)\)\{let ([\w$]+)=Math\.max\(0,Math\.ceil\(\(\2-50000\)\/50000\)\);return Math\.min\(([\w$]+),([\w$]+)\+\3\*1e4\)\}/g,
    replacer: (m, fn, arg, step, cap, base) =>
      `function ${fn}(${arg}){let _ct=${gate('classifier-timeout')}?globalThis.__clawgodHelpers.classifierTimeoutFloor(process.env.CLAWGOD_CLASSIFIER_TIMEOUT_MS):null;let ${step}=Math.max(0,Math.ceil((${arg}-50000)/50000));let _r=Math.min(${cap},${base}+${step}*1e4);return _ct===null?_r:Math.max(_r,_ct)}`,
    unique: true,
    optional: true,  // formula introduced in v2.1.251; older bundles predate it
  },
  {
    // Auto-mode classifier model resolution. v2.1.220+:
    //   function X(){let e=at(),n=Ih(),r=usr(n?.modelByMainModel,{vet:...})??avt(n?.model,"model");
    //     if(r)return{value:r,src:"gb"}; ... return{value:...,src:"default"}}
    // Returns {value,src}. GB-configured models go through a policy vet
    // (Z8t) that drops unknown model names, so third-party gateway models
    // cannot ride the GB override path. Patch: CLAWGOD_CLASSIFIER_MODEL
    // short-circuits the whole chain (returns before GB config / probe /
    // main-model mapping). Unset → original behavior.
    id: 'classifier-model',
    toggleable: true,
    name: 'Auto-mode classifier model override (CLAWGOD_CLASSIFIER_MODEL)',
    pattern: /function ([\w$]+)\(\)\{let [\w$]+=[\w$]+\(\),[\w$]+=[\w$]+\(.*?\),[\w$]+=[\w$]+\([\w$]+\?\.modelByMainModel,\{vet:/g,
    replacer: (m, fn) =>
      `function ${fn}(){let _cm=process.env.CLAWGOD_CLASSIFIER_MODEL?.trim();if(_cm&&${gate('classifier-model')})return{value:_cm,src:"default"};` + m.slice(m.indexOf('{') + 1),
    unique: true,
    optional: true,  // v2.1.220+
  },
  {
    // Auto-mode classifier maxRetries default (v2.1.220+):
    //   function X(){let n=Ih()?.maxRetries;return typeof n==="number"&&
    //     Number.isInteger(n)&&n>=0?{value:n,src:"gb"}:{value:s4,src:"default"}}
    // s4 = the maxRetries constant (4) declared near the timing constants;
    // it also feeds stage1 ceilingMs = max(F,(s4+1)*base). Patch:
    // CLAWGOD_CLASSIFIER_RETRIES overrides the default before the GB
    // lookup (same integer ≥0 validation; blank/invalid falls through,
    // matching unset).
    id: 'classifier-retries',
    toggleable: true,
    name: 'Auto-mode classifier retries override (CLAWGOD_CLASSIFIER_RETRIES)',
    pattern: /function ([\w$]+)\(\)\{let [\w$]+=[\w$]+\([^)]*\)\?\.maxRetries;return typeof [\w$]+==="number"&&Number\.isInteger\([\w$]+\)&&[\w$]+>=0\?{value:[\w$]+,src:"gb"}:{value:([\w$]+),src:"default"\}\}/g,
    replacer: (m, fn) =>
      `function ${fn}(){let _cr=process.env.CLAWGOD_CLASSIFIER_RETRIES?.trim();if(${gate('classifier-retries')}&&_cr!==undefined&&_cr!==""&&Number.isInteger(+_cr)&&+_cr>=0)return{value:+_cr,src:"default"};` + m.slice(m.indexOf('{') + 1),
    unique: true,
    optional: true,  // v2.1.220+; ≤v2.1.143 uses a plain constant
  },
  {
    // v2.1.158+: provider gate refactored into helper function:
    //   function mw$(H){if(H==="firstParty"||H==="anthropicAws")return!0;return CH(process.env.CLAUDE_CODE_ENABLE_AUTO_MODE)}
    //   Called as: if(!mw$(q))return!1;  inside the auto-mode model gate.
    //   Lookahead ensures we only strip the call inside the auto-mode gate
    //   (the next 300 chars must contain !=="firstParty") and not unrelated
    //   if(!fn(x))return!1; patterns elsewhere.
    //   Not present in ≤v2.1.149 (provider gate was inline).
    id: 'auto-mode-helper-gate',
    toggleable: true,
    name: 'Auto-mode unlock for third-party API (provider helper gate)',
    pattern: /if\(!([\w$]+)\(([\w$]+)\)\)return!1;(?=(?:(?!function\s).){0,300}!=="firstParty")/g,
    replacer: (m) => `if(globalThis.__clawgodPatches?.[${JSON.stringify('auto-mode-helper-gate')}]===!1&&` + m.slice(3, -10) + `)return!1;`,
    optional: true,
  },
  {
    // ≤v2.1.149: if(Y!=="firstParty"&&Y!=="anthropicAws")return!1;
    // v2.1.158+: if(q!=="firstParty"&&q!=="anthropicAws"&&($==="claude-opus-4-6"||…))return!1;
    // v2.1.214+: if(r!=="firstParty"&&!d6(r)&&(t==="claude-opus-4-6"||…))return!1;
    //   "anthropicAws" replaced by helper function !fn(var).
    //   Match both: \1!=="anthropicAws" OR !fn(\1).
    id: 'auto-mode-inline-gate',
    toggleable: true,
    name: 'Auto-mode unlock for third-party API (inline gate)',
    pattern: /if\(([\w$]+)!=="firstParty"&&(?:\1!=="anthropicAws"|![\w$]+\(\1\))[^;]*\)return!1;/g,
    replacer: (m) => `if(globalThis.__clawgodPatches?.[${JSON.stringify('auto-mode-inline-gate')}]===!1&&` + m.slice(3, -10) + `)return!1;`,
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
    //
    // v2.1.232+ wraps the action handler in a framework helper. The helper
    // is a minified identifier whose name drifts across builds:
    //   .action(async()=>{…})              ≤v2.1.231
    //   .action(t(async(a)=>{…}))          v2.1.232 … v2.1.237
    //   .action(n(async(u)=>{…}))          v2.1.238+
    // Match any one-letter minified helper via `identifier(` rather than
    // hardcoding a name, so a future rename keeps matching.
    id: 'update-redirect',
    name: "Redirect `claude update` to clawgod self-update",
    pattern: /(\.command\("update"\)\.alias\("upgrade"\)\.description\("[^"]+"\))(\.action\((?:[A-Za-z_$][\w$]*\()?async\([^)]*\)=>\{)/g,
    replacer: (m, chain, action) => {
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
        "$u='https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1';" +
        "if($p){iex(irm -Proxy $p $u)}else{iex(irm $u)}";
      const psB64 = Buffer.from(psScript, 'utf16le').toString('base64');
      return (
        chain + '.allowUnknownOption()' + action +
        `const _ui=process.argv.findIndex(a=>a==="update"||a==="upgrade");` +
        `const _ua=_ui>=0?process.argv.slice(_ui+1):[];` +
        `const _vi=_ua.indexOf("--version");` +
        `if(_vi>=0&&_ua[_vi+1])process.env.CLAWGOD_VERSION=_ua[_vi+1];` +
        `if(_ua.includes("--no-upgrade"))process.env.CLAWGOD_NO_UPGRADE="1";` +
        `if(_ua.includes("--lean-off"))process.env.CLAWGOD_LEAN_OFF="1";` +
        `if(_ua.includes("--lean-on"))process.env.CLAWGOD_LEAN_ON="1";` +
        `if(_ua.includes("--lean-max"))process.env.CLAWGOD_LEAN_MAX="1";` +
        `process.stderr.write("[clawgod] 'claude update' is handled by clawgod self-update.\\n[clawgod] To leave clawgod and use vanilla update: bash ~/.clawgod/install.sh --uninstall\\n[clawgod] Continuing now\\u2026\\n");` +
        `const _w=process.platform==='win32';` +
        `const _c=_w?['powershell','-NoProfile','-EncodedCommand','${psB64}']:['bash','-c','curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash'];` +
        `const _r=require('child_process').spawnSync(_c[0],_c.slice(1),{stdio:'inherit',env:process.env});` +
        `process.exit(_r.status||0);`
      );
    },
    sentinel: '.command("update").alias("upgrade")',
  },
  // ── 绿色主题 (patch 标识) ──

  {
    id: 'theme-logo-rgb',
    toggleable: true,
    name: 'Logo + brand color → green (RGB dark)',
    pattern: /(clawd_body:)"rgb\(215,119,87\)"/g,
    replacer: (m, key) => `${key}${gate('theme-logo-rgb')}?"rgb(34,197,94)":"rgb(215,119,87)"`,
  },
  {
    id: 'theme-logo-ansi',
    toggleable: true,
    name: 'Logo + brand color → green (ANSI)',
    pattern: /(clawd_body:)"ansi:redBright"/g,
    replacer: (m, key) => `${key}${gate('theme-logo-ansi')}?"ansi:greenBright":"ansi:redBright"`,
  },
  {
    id: 'theme-claude-rgb-dark',
    toggleable: true,
    name: 'Theme claude color → green (dark)',
    pattern: /(claude:)"rgb\(215,119,87\)"/g,
    replacer: (m, key) => `${key}${gate('theme-claude-rgb-dark')}?"rgb(34,197,94)":"rgb(215,119,87)"`,
  },
  {
    id: 'theme-claude-rgb-light',
    toggleable: true,
    name: 'Theme claude color → green (light)',
    pattern: /(claude:)"rgb\(255,153,51\)"/g,
    replacer: (m, key) => `${key}${gate('theme-claude-rgb-light')}?"rgb(22,163,74)":"rgb(255,153,51)"`,
  },
  {
    id: 'theme-shimmer-rgb',
    toggleable: true,
    name: 'Shimmer → green',
    pattern: /(claudeShimmer:)"rgb\(2[34]5,1[45]9,1[12]7\)"/g,
    replacer: (m, key) => `${key}${gate('theme-shimmer-rgb')}?"rgb(74,222,128)":${m.slice(key.length)}`,
  },
  {
    id: 'theme-shimmer-rgb-light',
    toggleable: true,
    name: 'Shimmer light → green',
    pattern: /(claudeShimmer:)"rgb\(255,183,101\)"/g,
    replacer: (m, key) => `${key}${gate('theme-shimmer-rgb-light')}?"rgb(34,197,94)":"rgb(255,183,101)"`,
  },
  {
    id: 'theme-hex',
    toggleable: true,
    name: 'Hex brand color → green',
    pattern: /"#da7756"/g,
    // OFF branch single-quoted so a re-run of the patcher cannot match it again
    replacer: () => `${gate('theme-hex')}?"#22c55e":'#da7756'`,
  },
  {
    id: 'theme-claude-ansi',
    toggleable: true,
    name: 'Theme claude color → green (ANSI)',
    pattern: /(claude:)"ansi:redBright"/g,
    replacer: (m, key) => `${key}${gate('theme-claude-ansi')}?"ansi:greenBright":"ansi:redBright"`,
  },
  {
    id: 'theme-shimmer-ansi',
    toggleable: true,
    name: 'Shimmer → green (ANSI)',
    pattern: /(claudeShimmer:)"ansi:yellowBright"/g,
    replacer: (m, key) => `${key}${gate('theme-shimmer-ansi')}?"ansi:greenBright":"ansi:yellowBright"`,
  },
  {
    id: 'theme-brief-rgb-dark',
    toggleable: true,
    name: 'Brief label claude color → green (RGB dark)',
    pattern: /(briefLabelClaude:)"rgb\(215,119,87\)"/g,
    replacer: (m, key) => `${key}${gate('theme-brief-rgb-dark')}?"rgb(34,197,94)":"rgb(215,119,87)"`,
  },
  {
    id: 'theme-brief-rgb-light',
    toggleable: true,
    name: 'Brief label claude color → green (RGB light)',
    pattern: /(briefLabelClaude:)"rgb\(255,153,51\)"/g,
    replacer: (m, key) => `${key}${gate('theme-brief-rgb-light')}?"rgb(22,163,74)":"rgb(255,153,51)"`,
  },
  {
    id: 'theme-brief-ansi',
    toggleable: true,
    name: 'Brief label claude color → green (ANSI)',
    pattern: /(briefLabelClaude:)"ansi:redBright"/g,
    replacer: (m, key) => `${key}${gate('theme-brief-ansi')}?"ansi:greenBright":"ansi:redBright"`,
  },

  // ── macOS Cmd+V 图片粘贴修复 ──

  {
    // Under Bun runtime (clawgod), macOS Cmd+V pastes the image file path
    // as text instead of triggering the clipboard image read. The paste
    // handler detects the path as an image file (gCc), tries to read it
    // via yCc, fails, and falls through to display the raw path as text.
    //
    // Fix: when all image path reads fail (L.length===0 && R.length>0)
    // and we're on macOS (d) with no other text (D.length===0), fall back
    // to the clipboard image reader (m()) — same path that Ctrl+V uses.
    //
    // Shape:
    //   if(L.length===0&&R.length>0)at("input_image_drag","read_failed"),D.push(...R)
    //
    // Patched:
    //   if(L.length===0&&R.length>0){at("input_image_drag","read_failed");if(d&&D.length===0){m();return}D.push(...R)}
    id: 'macos-cmdv-image-paste',
    name: 'macOS Cmd+V image paste fallback to clipboard read',
    pattern: /if\(([\w$]+)\.length===0&&([\w$]+)\.length>0\)([\w$]+)\("input_image_drag","read_failed"\),([\w$]+)\.push\(\.\.\.\2\)/g,
    replacer: (m, L, R, at, D) =>
      `if(${L}.length===0&&${R}.length>0){${at}("input_image_drag","read_failed");if(d&&${D}.length===0){m();return}${D}.push(...${R})}`,
    sentinel: '"input_image_drag","read_failed"',
    optional: true,
  },

  // ── Glob/Grep 工具恢复 ──

  {
    // Bun inlines EMBEDDED_SEARCH_TOOLS env as literal "true" at compile time.
    // This makes bC() always return true → Wft() returns the shadow set
    // containing "Glob" and "Grep" → those tools are hidden from the user.
    // Under clawgod (Bun runtime, not native binary) the env is unset, but
    // the code still says ct("true") instead of ct(process.env.EMBEDDED_SEARCH_TOOLS).
    //
    // Shape:
    //   function bC(){if(!ct("true"))return!1;if(mEr())return!1;
    //     return process.env.CLAUDE_CODE_ENTRYPOINT!=="local-agent"}
    //
    // Patch: replace ct("true") with ct(process.env.EMBEDDED_SEARCH_TOOLS)
    // so the guard reads the actual env var (unset → falsy → return false →
    // Glob/Grep tools available).
    id: 'restore-search-tools',
    name: 'Restore Glob/Grep tools (un-inline EMBEDDED_SEARCH_TOOLS)',
    pattern: /function ([\w$]+)\(\)\{if\(!([\w$]+)\("true"\)\)return!1;if\([\w$]+\(\)\)return!1;return process\.env\.CLAUDE_CODE_ENTRYPOINT!=="local-agent"\}/g,
    replacer: (m, fn, envCheck) =>
      `function ${fn}(){if(!${envCheck}(process.env.EMBEDDED_SEARCH_TOOLS))return!1;if(typeof globalThis.__dpBinOk>"u"){try{var _w=process.platform==="win32"?"where":"which";require("child_process").execFileSync(_w,["bfs"],{timeout:2e3});require("child_process").execFileSync(_w,["ugrep"],{timeout:2e3});globalThis.__dpBinOk=!0}catch{globalThis.__dpBinOk=!1}}if(!globalThis.__dpBinOk)return!1;return process.env.CLAUDE_CODE_ENTRYPOINT!=="local-agent"}`,
    sentinel: 'ct("true")',
    optional: true,
  },

  // ── 地区隐写中和 (v2.1.197+) ──

  {
    // v2.1.197+: geo-steganography in system prompt date string.
    // qla(e) builds "Today{apostrophe}s date is {date}." where:
    //   - the apostrophe encodes proxy-detection state (U+0027/U+2019/U+02BC/U+02B9)
    //   - the date separator encodes timezone (- for non-CN, / for CN)
    //
    // Shape:
    //   function qla(e){let t=rdp(),n=odp(t?.known??!1,t?.labKw??!1),
    //     r=t?.cnTZ?e.replaceAll("-","/"):e;return`Today${n}s date is ${r}.`}
    //
    // Patch: replace entire function body to always use ASCII apostrophe
    // and pass through the date string unmodified.
    id: 'geo-stego-date',
    toggleable: true,
    name: 'Neutralize geo-steganography in date string (qla)',
    pattern: /function ([\w$]+)\([\w$]+\)\{let [\w$]+=[\w$]+\(\),[\w$]+=[\w$]+\([\w$]+\?\.[\w$]+\?\?!1,[\w$]+\?\.[\w$]+\?\?!1\),[\w$]+=[\w$]+\?\.[\w$]+\?[\w$]+\.replaceAll\("-","\/"\):[\w$]+;return`Today\$\{[\w$]+\}s date is \$\{[\w$]+\}\.`\}/g,
    replacer: (m) => {
      // Extract function name and parameter name from the match
      const fnMatch = m.match(/^function ([\w$]+)\(([\w$]+)\)/);
      if (!fnMatch) return m;
      const [, fn, param] = fnMatch;
      return `function ${fn}(${param}){if(${gate('geo-stego-date')})return\`Today's date is \${${param}}.\`;` + m.slice(fnMatch[0].length, -1) + `}`;
    },
    sentinel: 'replaceAll("-","/")',
  },
  {
    // v2.1.197+: rdp() performs three-axis geo detection:
    //   1. timezone === "Asia/Shanghai" || "Asia/Urumqi"  → cnTZ
    //   2. ANTHROPIC_BASE_URL hostname in XOR-obfuscated domain blocklist → known
    //   3. ANTHROPIC_BASE_URL contains CN-LLM vendor keywords → labKw
    //
    // Shape:
    //   function rdp(){if(vrt())return null;let e=ndp(),t=ekt(),
    //     n=t==="Asia/Shanghai"||t==="Asia/Urumqi";if(!e)return{known:!1,labKw:!1,cnTZ:n,host:null};
    //     return{known:edp().some(...),labKw:tdp().some(...),cnTZ:n,host:e}}
    //
    // Patch: always return null (same as firstParty path), disabling all detection.
    id: 'geo-detect-probe',
    toggleable: true,
    name: 'Neutralize geo-detection probe (rdp)',
    pattern: /function ([\w$]+)\(\)\{if\([\w$]+\(\)\)return null;let [\w$]+=[\w$]+\(\),[\w$]+=[\w$]+\(\),[\w$]+=[\w$]+==="Asia\/Shanghai"\|\|[\w$]+==="Asia\/Urumqi"[\s\S]*?\}\}/g,
    replacer: (m) => {
      const fn = m.match(/^function ([\w$]+)/)[1];
      return `function ${fn}(){if(${gate('geo-detect-probe')})return null;` + m.slice(`function ${fn}(){`.length, -1) + `}`;
    },
    sentinel: 'Asia/Shanghai',
  },
  {
    // v2.1.197+: odp(known, labKw) selects a Unicode apostrophe to encode
    // proxy detection state into the system prompt:
    //   !known && !labKw → U+0027 (ASCII)
    //   known  && !labKw → U+2019 (RIGHT SINGLE QUOTATION MARK)
    //   !known && labKw  → U+02BC (MODIFIER LETTER APOSTROPHE)
    //   known  && labKw  → U+02B9 (MODIFIER LETTER PRIME)
    //
    // Shape:
    //   function odp(e,t){if(!e&&!t)return"'";if(e&&!t)return"'";
    //     if(!e&&t)return"ʼ";return"ʹ"}
    //
    // Patch: always return ASCII apostrophe regardless of detection state.
    // The return values may appear as \uXXXX escapes or literal UTF-8 in
    // the bundle depending on bundler version. Match both forms.
    // Defense-in-depth — qla patch above already bypasses the call to odp,
    // but if qla's shape changes this keeps odp harmless.
    id: 'geo-apostrophe-stego',
    toggleable: true,
    name: 'Neutralize apostrophe steganography (odp)',
    pattern: new RegExp(
      'function ([\\w$]+)\\(([\\w$]+),([\\w$]+)\\)\\{' +
      'if\\(!\\2&&!\\3\\)return"\'";' +
      'if\\(\\2&&!\\3\\)return"(?:\\\\u2019|\\u2019)";' +
      'if\\(!\\2&&\\3\\)return"(?:\\\\u02[Bb][Cc]|\\u02BC)";' +
      'return"(?:\\\\u02[Bb]9|\\u02B9)"\\}',
      'g'
    ),
    replacer: (m) => {
      const [_, fn, params] = m.match(/^function ([\w$]+)\(([^)]*)\)/);
      return `function ${fn}(${params}){if(${gate('geo-apostrophe-stego')})return"'";` + m.slice(m.indexOf('{') + 1, -1) + `}`;
    },
    optional: true,  // defense-in-depth; rdp→null already neutralizes the stego channel
  },

  // ── 限制移除 ──

  {
    id: 'remove-cyber-risk',
    toggleable: true,
    name: 'Remove CYBER_RISK_INSTRUCTION',
    pattern: /([\w$]+)="(IMPORTANT: Assist with authorized security testing[^"]*)"/g,
    replacer: (m, varName, orig) => `${varName}=${gate('remove-cyber-risk')}?"":${JSON.stringify(orig)}`,
    sentinel: 'Assist with authorized security testing',
  },
  {
    id: 'remove-url-restriction',
    toggleable: true,
    name: 'Remove URL generation restriction',
    pattern: /(\n\$\{[\w$]+\})(\nIMPORTANT: You must NEVER generate or guess URLs[^.]*\. You may use URLs provided by the user in their messages or local files\.)/g,
    // Gate the whole original region (incl. the live \n${var} prefix) inside a nested
    // template: OFF renders it byte-identically (var stays interpolated), ON drops
    // the entire span like the old delete-only patch did.
    // ON drops the whole region (old delete behavior); OFF renders it back with the
    // live ${var} interpolation preserved and the sentence emitted as an escaped
    // single-quoted string so a re-run of the patcher cannot match it again.
    replacer: (m, prefix, sentence) => `\${${gate('remove-url-restriction')}?"":\`${prefix}\`+'${sentence.replace('\n', '\\n')}'}`,
    sentinel: 'IMPORTANT: You must NEVER generate or guess URLs',
  },
  {
    id: 'remove-cautious-actions',
    toggleable: true,
    name: 'Remove cautious actions section',
    // v2.1.88-~v2.1.122: function GSY(){return`# Executing actions...`}
    // v2.1.123+: function _j3(H){if(LE8(H)==="compact")return`# Executing...short`;return`# Executing...long`}
    pattern: /function ([\w$]+)\(([\w$]*)\)\{(?:if\([\s\S]{1,200}?\)return`# Executing actions with care\n\n[\s\S]*?`;)?return`# Executing actions with care\n\n[\s\S]*?`\}/g,
    replacer: (m, fn, arg) => `function ${fn}(${arg}){if(${gate('remove-cautious-actions')})return\`\`;` + m.slice(`function ${fn}(${arg}){`.length, -1) + `}`,
    sentinel: '# Executing actions with care',
  },
  {
    id: 'remove-not-logged-in',
    toggleable: true,
    name: 'Remove "Not logged in" notice',
    pattern: /"(Not logged in\. Run [\w ]+ to authenticate\.)"/g,
    // OFF branch single-quoted so a re-run of the patcher cannot match it again
    replacer: (m, orig) => `(${gate('remove-not-logged-in')}?"":'${orig}')`,
    optional: true,
  },

  // ── 消息过滤 ──

  {
    // v2.1.88-~v2.1.91: fn()!=="ant"){if(q.attachment.type==="hook_additional_context"...
    // v2.1.92+        : fn()!=="ant"&&paY.has(q.attachment.type) — paY is an empty Set
    //                    in v2.1.110, so this filter is effectively a no-op; patch anyway
    //                    to guard against paY being populated in future versions.
    id: 'attachment-filter-bypass',
    toggleable: true,
    name: 'Attachment filter bypass',
    pattern: /([\w$]+)\(\)!=="ant"(&&[\w$]+\.has\([\w$]+\.attachment\.type\)|\)\{if\([\w$]+\.attachment\.type==="hook_additional_context")/g,
    // alt1 (infix): X()!=="ant"&&Set.has(...)  -> (G?!1:X()!=="ant")&&Set.has(...)
    // alt2 (guard): X()!=="ant"){if(...)        -> (G?!1:X()!=="ant")){if(...)
    //   alt2's ')' closes the enclosing if( — the paren-wrapped replacement
    //   needs its own closer, hence the doubled ')' in that branch.
    replacer: (m) => m.replace(/([\w$]+)\(\)!=="ant"(&&|\))/, (cm, f, sep) =>
      sep === '&&'
        ? `(${gate('attachment-filter-bypass')}?!1:${f}()!=="ant")&&`
        : `(${gate('attachment-filter-bypass')}?!1:${f}()!=="ant"))`),
    optional: true,  // filter may be removed entirely in future versions
  },
  {
    // Legacy (≤v2.1.91) ternary form: fn()!=="ant"?tRY(_,sRY(K)):K
    id: 'message-filter-legacy',
    toggleable: true,
    name: 'Message list filter bypass (legacy ternary)',
    pattern: /([\w$]+)\(\)!=="ant"\?([\w$]+)\(([\w$]+),([\w$]+)\(([\w$]+)\)\):([\w$]+)/g,
    replacer: (m, fn, tRY, underscore, sRY, K, fallback) => m.replace(/^([\w$]+)\(\)!=="ant"\?/, (g, f) => `(${gate('message-filter-legacy')}?!1:${f}()!=="ant")?`),
    optional: true,  // removed in v2.1.92+
  },
  {
    // v2.1.92+ (s_8): if(fn()==="ant")return _;let z=...;return FaY(_,z)
    // Flip the guard so non-ant users also return the pre-filtered list.
    id: 'message-filter-s8',
    toggleable: true,
    name: 'Message list filter bypass (s_8 form)',
    pattern: /if\(([\w$]+)\(\)==="ant"\)return ([\w$]+);let ([\w$]+)=([\w$]+) instanceof Set\?\4:([\w$]+)\(\4\);return ([\w$]+)\(\2,\3\)/g,
    replacer: (m, fn, ret) => m.replace(/if\(([\w$]+)\(\)==="ant"\)/, (g, f) => `if(${gate('message-filter-s8')}||${f}()==="ant")`),
    optional: true,  // legacy versions had a ternary instead
  },
  {
    // Shell-integration generator (iT6 in v2.1.140, was Wa1 in older versions)
    // emits a zsh/bash function that calls the native claude binary with
    // ARGV0=ugrep|rg|... for multitool dispatch. After clawgod installs, the
    // baked path points at our shell-script launcher — but shell scripts
    // CANNOT preserve argv[0] (kernel shebang re-exec overwrites it, and zsh
    // additionally refuses to export ARGV0 as env). The shell function then
    // fails because bun receives e.g. -G and errors with "Invalid Argument".
    //
    // Fix: redirect the baked path to claude.orig (the native binary backup
    // clawgod creates at install time). Then the multitool dispatch reaches
    // a real binary that honors argv[0]. See issue #82.
    //
    // Generator shape across versions:
    //   v2.1.88 (Wa1):  let Y=E4([_]),...  ← _ is the claude binary path, no in-function compute
    //   v2.1.140 (iT6): let ...,z=FJ$.join(Le(),A?"claude.exe":"claude"),Y=A?rL(z):z,...
    //                   ← path computed inside via join(versionsDir, "claude[.exe]")
    // Anchor on the join(...) ternary form unique to the generator — the
    // bare "claude.exe":"claude" string also appears in u18() (basename
    // helper) but never inside a path.join(), so this regex hits exactly the
    // shell-integration generator and nothing else.
    id: 'shell-integration-orig',
    name: 'Shell integration → claude.orig (multitool dispatch fix)',
    pattern: /([\w$]+\.join\([\w$]+\(\),[\w$]+\?)"claude\.exe":"claude"(\))/g,
    replacer: (m, prefix, suffix) => `${prefix}"claude.orig.exe":"claude.orig"${suffix}`,
    sentinel: '?"claude.exe":"claude")',
    optional: true,  // v2.1.88-era bundles compute the path differently
  },
];

// ─── Main ─────────────────────────────────────────────────

// cli.original path (legacy single-bundle) or graph dir (v2.1.245+)
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const revert = args.includes('--revert');
const dumpFeatures = args.includes('--dump-features');

// Build-time export: `patch.mjs --dump-features` prints the inverted
// registry (patch id → owning feature ids) as JSON and exits. build.js
// consumes this to weave the META constant into the wrapper sources, so
// FEATURES stays the single source of truth (no hand-maintained copy).
// Runs BEFORE any file is touched — safe to invoke anywhere.
if (dumpFeatures) {
  const meta = {};
  for (const [fid, def] of Object.entries(FEATURES)) {
    for (const pid of def.patchIds) {
      (meta[pid] ??= []).push(fid);
    }
  }
  console.log(JSON.stringify(meta));
  process.exit(0);
}

// ── Registry self-check (authoring guardrail, fails fast) ──
// Enforces the classification contract on the static data above, so a
// metadata mistake cannot ship silently:
//   1. every patch has a unique id
//   2. FEATURES only references existing ids, and only toggleable ones
//      (a core patch being referenced is a contradiction — core is not
//      toggleable by definition)
//   3. a toggleable patch must be referenced by at least one feature
//      (otherwise the id was mistyped, or the author forgot to register it
//      and the toggle would silently never map to anything)
// Any violation aborts the patcher before a single file is touched — the
// same code path runs in install.sh / install.ps1 and CI, so authoring
// errors surface at build time, not as a user's broken toggle.
(function validateRegistry() {
  const errs = [];
  const byId = new Map();
  for (const p of patches) {
    if (!p.id) errs.push(`patch without id: ${p.name}`);
    else if (byId.has(p.id)) errs.push(`duplicate patch id: ${p.id}`);
    else byId.set(p.id, p);
  }
  for (const [fid, def] of Object.entries(FEATURES)) {
    for (const pid of def.patchIds) {
      const p = byId.get(pid);
      if (!p) { errs.push(`feature '${fid}' references unknown patch id '${pid}'`); continue; }
      if (!p.toggleable) errs.push(`feature '${fid}' references non-toggleable patch '${pid}'`);
    }
  }
  for (const p of patches) {
    const referenced = Object.values(FEATURES).some((f) => f.patchIds.includes(p.id));
    if (p.toggleable && !referenced) errs.push(`toggleable patch '${p.id}' is referenced by no feature`);
  }
  if (errs.length > 0) {
    console.error('❌ Feature registry invalid:');
    for (const e of errs) console.error('   -', e);
    process.exit(1);
  }
})();

// The patcher itself is unconditionally stateless w.r.t. feature config:
// every patch always bakes in. Whether a toggleable patch's effect is ON
// is decided at claude launch (wrapper loads patches.json +
// CLAWGOD_FEATURE_* env) — never here.

const GRAPH_DIR = join(__dirname, 'bunfs');
const isGraph = existsSync(GRAPH_DIR);

if (revert) {
  if (isGraph) {
    // graph: restore each file from its .bak (no-op if none) — full graph
    // backup isn't taken for chunks; only the entry has a .bak. Re-extract
    // instead: the safest revert for graph installs is to rerun extract.
    console.log('⚠️  Graph install detected — run install.sh to re-extract clean source.');
    process.exit(0);
  }
  if (!existsSync(BACKUP)) { console.error('❌ No backup found'); process.exit(1); }
  copyFileSync(BACKUP, TARGET);
  console.log('✅ Reverted from backup');
  process.exit(0);
}

// ── Load target(s) ─────────────────────────────
// isGraph: files = { 'cli.original.cjs': '...', 'bunfs/_444.js': '...', ... }
// else:    files = { 'cli.original.cjs': '...' }
let files = {};
if (isGraph) {
  files[TARGET] = readFileSync(TARGET, 'utf8');
  for (const f of readdirSync(GRAPH_DIR)) {
    if (!/\.js$/.test(f) && !/\.mjs$/.test(f)) continue;
    files[join(GRAPH_DIR, f)] = readFileSync(join(GRAPH_DIR, f), 'utf8');
  }
} else {
  if (!existsSync(TARGET)) {
    console.error('❌ Target not found:', TARGET);
    process.exit(1);
  }
  files[TARGET] = readFileSync(TARGET, 'utf8');
}

// Extract version from entry content
const version = (files[TARGET] || '').match(/Version:\s*([\d.]+)/)?.[1] || 'unknown';
const isCJSBundle = !isGraph; // legacy

console.log(`\n${'═'.repeat(55)}`);
console.log(`  ClawGod (universal)`);
console.log(`  Target: cli.original.cjs (v${version}) ${isGraph ? `[graph: ${Object.keys(files).length} files]` : ''}`);
console.log(`  Mode: ${dryRun ? 'DRY RUN' : verify ? 'VERIFY' : 'APPLY'}`);
console.log(`${'═'.repeat(55)}\n`);

// unified search: gather all matches of a pattern across every loaded file.
// validate() receives the full file text so surrounding-context patterns keep working.
function collectMatches(p) {
  const out = []; // { file, match, matches }
  for (const [fname, content] of Object.entries(files)) {
    const matches = [...content.matchAll(p.pattern)];
    if (matches.length === 0) continue;
    let rel = matches;
    // per-file validate / selectIndex — but these were designed for a single
    // bundle string. For graph, the pattern is applied per file, so each file
    // is an independent unit. validate() sees that file's content.
    if (p.validate) rel = matches.filter((m) => p.validate(m[0], content));
    out.push({ file: fname, content, matches: rel });
  }
  return out;
}

let applied = 0, skipped = 0, failed = 0;

for (const p of patches) {
  const fileMatches = collectMatches(p);

  /*
   * Patch semantics per file:
   *  - If a file contains match(es), apply replacement to that file.
   *  - "unique" / "validate" / "selectIndex" still constrain within one file.
   *  - The overall patch reports applied once if ANY file changed.
   *  - The "already applied / sentinel / stale" logic: if NO file has any
   *    match, fall through to the sentinel-based diagnostics (same as legacy).
   */
  let fileChangedCount = 0;
  const relevantFiles = fileMatches.filter((fm) => fm.matches.length > 0);

  // unique: if the aggregated count is >1 *across files* but the pattern
  // should hit exactly once in the whole app, we only allow applying to a
  // single file. Legacy enforced uniqueness over the whole bundle string;
  // graph splits it per-file so each file normally has ≤1 match anyway.
  let totalMatches = 0;
  for (const fm of fileMatches) totalMatches += fm.matches.length;

  if (relevantFiles.length === 0) {
    if (p.optional) {
      console.log(`  ⏭  ${p.name} (not present in this version)`);
      skipped++;
      continue;
    }
    if (p.sentinel !== undefined) {
      const sentinels = Array.isArray(p.sentinel) ? p.sentinel : [p.sentinel];
      const stillPresent = sentinels.filter((s) => Object.values(files).some((c) => c.includes(s)));
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
    console.log(`  ⬚  ${p.name} — ${totalMatches} match(es), not yet applied`);
    skipped++;
    continue;
  }

  // Apply per file. For "unique" patches that would match in multiple files,
  // only apply to the first (they are expected to be single-site).
  const uniqueLimit = p.unique ? 1 : Infinity;
  let appliedFiles = 0;
  for (const fm of relevantFiles) {
    if (appliedFiles >= uniqueLimit) break;
    let changed = false;
    let count = 0;
    for (const m of fm.matches) {
      const replacement = p.replacer(m[0], ...m.slice(1));
      if (replacement !== m[0]) {
        if (!dryRun) {
          files[fm.file] = files[fm.file].replace(m[0], () => replacement);
        } else {
          // in dry-run mutate the local copy only for counting
          const tmp = fm.content;
          files[fm.file] = tmp.replace(m[0], () => replacement);
        }
        changed = true;
        count++;
      }
    }
    if (changed) appliedFiles++;
    fileChangedCount += count;
  }

  if (fileChangedCount > 0) {
    console.log(`  ✅ ${p.name} (${fileChangedCount} replacement${fileChangedCount > 1 ? 's' : ''} in ${appliedFiles} file${appliedFiles > 1 ? 's' : ''})`);
    applied++;
  } else if (relevantFiles.length > 0) {
    console.log(`  ⏭  ${p.name} (no change needed)`);
    skipped++;
  }
}

console.log(`\n${'─'.repeat(55)}`);
console.log(`  Result: ${applied} applied, ${skipped} skipped, ${failed} failed`);

if (!dryRun && !verify && applied > 0) {
  // backup the entry (legacy semantics); graph writes all files in place
  if (!existsSync(BACKUP)) {
    copyFileSync(TARGET, BACKUP);
    console.log(`  📦 Backup: ${BACKUP}`);
  }
  for (const [fname, content] of Object.entries(files)) {
    writeFileSync(fname, content, 'utf8');
  }
  const origSize = isGraph ? 0 : (readFileSync(BACKUP, 'utf8').length || 0);
  console.log(`  📝 Written: ${Object.keys(files).length} file(s) ${isGraph ? '(graph)' : ''}`);
}

console.log(`${'═'.repeat(55)}\n`);
