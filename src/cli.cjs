#!/usr/bin/env bun
const { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, renameSync } = require('fs');
const { join, basename } = require('path');
const { homedir } = require('os');
const { spawnSync } = require('child_process');

const clawgodDir = join(homedir(), '.clawgod');

// Note: there used to be a "drift detection" block here that scanned
// ~/.local/share/claude/versions/ for a newer binary and silently re-patched.
// Removed because:
//   1. Windows users don't have a `versions/` directory at all (Anthropic's
//      Windows install doesn't follow that convention).
//   2. We patch out `claude update` (it would otherwise overwrite the bun
//      runtime under our launcher), so `versions/` no longer auto-grows
//      on a healthy clawgod install.
// In practice the block was reading a directory that never changes, but
// could *retract* a fresher version that install.sh just pulled from npm
// registry — putting users into a re-patch loop. Upgrades now go through
// the patched `claude update` → install.sh redirect, which always pulls
// the latest from npm.

// One-time migration: earlier wrapper versions set CLAUDE_CONFIG_DIR=~/.clawgod,
// which made Claude Code read/write ~/.clawgod/.claude.json instead of the
// native ~/.claude.json (the file holding MCP config, project history, session
// index). Move it back transparently on first run after upgrade.
const nativeClaudeJson = join(homedir(), '.claude.json');
const strayClaudeJson = join(clawgodDir, '.claude.json');
if (existsSync(strayClaudeJson) && !existsSync(nativeClaudeJson)) {
  try { renameSync(strayClaudeJson, nativeClaudeJson); } catch {}
}

const providerDir = clawgodDir;
const configFile = join(providerDir, 'provider.json');

const defaultConfig = {
  apiKey: '',
  baseURL: 'https://api.anthropic.com',
  model: '',
  smallModel: '',
  timeoutMs: 60000,
};

let config = { ...defaultConfig };
if (existsSync(configFile)) {
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf8'));
    config = { ...defaultConfig, ...raw };
  } catch {}
} else {
  mkdirSync(providerDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2) + '\n');
}

const hasProviderApiKey = !!config.apiKey;

if (hasProviderApiKey) {
  process.env.ANTHROPIC_API_KEY = config.apiKey;
  if (config.baseURL) process.env.ANTHROPIC_BASE_URL = config.baseURL;
  if (config.model) process.env.ANTHROPIC_MODEL = config.model;
  if (config.smallModel) process.env.ANTHROPIC_SMALL_FAST_MODEL = config.smallModel;
  if (config.baseURL && !/anthropic\.com/i.test(config.baseURL)) {
    process.env.ANTHROPIC_AUTH_TOKEN ??= config.apiKey;
  }
} else if (config.baseURL && config.baseURL !== defaultConfig.baseURL) {
  process.env.ANTHROPIC_BASE_URL ??= config.baseURL;
}

if (config.timeoutMs) {
  process.env.API_TIMEOUT_MS ??= String(config.timeoutMs);
}
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
process.env.DISABLE_INSTALLATION_CHECKS ??= '1';
// Use system ripgrep (extracted vendor rg path was build-time-baked; system
// rg is the most reliable fallback under Bun runtime).
process.env.USE_BUILTIN_RIPGREP ??= '1';

// ─── 第三方 API 智能优化 ─────────────────────────────────
// 当检测到使用非 api.anthropic.com 的 baseURL 时，自动应用
// 第三方 API 兼容配置，避免 400 错误同时保持功能完整。
const isThirdParty = config.baseURL && !/anthropic\.com/i.test(config.baseURL);

if (isThirdParty) {
  // 1. 禁用 beta headers — 避免第三方 API 不认识的 beta 导致 400
  //    (NI6() 补丁已确保 Tool Search 不受此影响)
  process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ??= '1';

  // 2. 确保 Tool Search 启用（覆盖 DISABLE_EXPERIMENTAL_BETAS 的影响）
  process.env.ENABLE_TOOL_SEARCH ??= 'auto:0';

  // 3. 合理的超时（第三方 API 通常比官方慢）
  process.env.API_TIMEOUT_MS ??= String(config.timeoutMs || 120000);

  // 4. 流看门狗超时（慢响应不误判为断连）
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS ??= '120000';
}

const featuresFile = join(providerDir, 'features.json');
if (!process.env.CLAUDE_INTERNAL_FC_OVERRIDES && existsSync(featuresFile)) {
  try {
    const raw = readFileSync(featuresFile, 'utf8');
    JSON.parse(raw);
    process.env.CLAUDE_INTERNAL_FC_OVERRIDES = raw;
  } catch {}
}

require('./cli.original.cjs');
