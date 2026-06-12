#!/usr/bin/env node
/**
 * ClawGod build script.
 *
 * Reads src/ files and install script templates, then produces final
 * install.sh and install.ps1 with heredoc content embedded.
 *
 * src/ layout:
 *   generic/  - shared by both platforms
 *   unix/     - install.sh only
 *   windows/  - install.ps1 only
 *   template/ - install.sh and install.ps1 templates
 *
 * Platform dirs override generic/ for same-named files.
 */

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');

const root = __dirname;
const src = join(root, 'src');

// ─── Placeholder → source file mapping ───────────────────────────────

const PLACEHOLDER_MAP = {
  'extract-natives.mjs': 'extractor.js',
  'post-process.mjs': 'post-processor.js',
  'repatch.mjs': 'repatcher.js',
  'cli.cjs': 'wrapper.js',
  'patch.mjs': 'patcher.js',
  'features.json': 'features.json',
  'npm-fetch.mjs': 'npm-fetch.js',
  'openai-proxy.cjs': 'openai-proxy.js',
  'lean-remove.cjs': 'lean-remove.js',
  'lean-apply.cjs': 'lean-apply.js',
};

// Build a content map for a specific platform.
// Lookup order: {platform}/ → generic/
function buildContentMap(platform) {
  const map = {};
  for (const [placeholder, filename] of Object.entries(PLACEHOLDER_MAP)) {
    let found = null;
    for (const dir of [platform, 'generic']) {
      const p = join(src, dir, filename);
      if (existsSync(p)) { found = p; break; }
    }
    if (!found) {
      // Some files only exist in one platform's template (e.g. npm-fetch.mjs
      // is PS1-only). Skip silently — if the template doesn't use the
      // placeholder, no harm done.
      continue;
    }
    map[placeholder] = readFileSync(found, 'utf8');
  }
  return map;
}

// ─── Template rendering ──────────────────────────────────────────────

function renderTemplate(templatePath, contentMap) {
  let template = readFileSync(templatePath, 'utf8');

  for (const [name, content] of Object.entries(contentMap)) {
    const placeholder = `{{CONTENT:${name}}}`;
    const replacement = content.endsWith('\n') ? content.slice(0, -1) : content;
    // Function-form replace: avoids $$/$&/$1 special pattern interpretation.
    template = template.replaceAll(placeholder, () => replacement);
  }

  const unresolved = template.match(/{{CONTENT:[^}]+}}/g);
  if (unresolved) {
    throw new Error(`Unresolved placeholders in ${templatePath}: ${[...new Set(unresolved)].join(', ')}`);
  }

  return template;
}

// ─── Build ───────────────────────────────────────────────────────────

function build() {
  const shTemplate = join(src, 'template', 'install.sh');
  const ps1Template = join(src, 'template', 'install.ps1');

  if (!existsSync(shTemplate)) {
    console.error('Template not found:', shTemplate);
    process.exit(1);
  }
  if (!existsSync(ps1Template)) {
    console.error('Template not found:', ps1Template);
    process.exit(1);
  }

  const shMap = buildContentMap('unix');
  const ps1Map = buildContentMap('windows');

  const shContent = renderTemplate(shTemplate, shMap);
  const ps1Content = renderTemplate(ps1Template, ps1Map);

  writeFileSync(join(root, 'install.sh'), shContent, 'utf8');
  writeFileSync(join(root, 'install.ps1'), ps1Content, 'utf8');

  console.log(`Built: install.sh (${(shContent.length / 1024).toFixed(0)} KB)`);
  console.log(`Built: install.ps1 (${(ps1Content.length / 1024).toFixed(0)} KB)`);
}

build();
