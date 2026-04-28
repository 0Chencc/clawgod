import './styles/index.css';
import { sections, type PatchKind } from './data';

// ─── Markup ─────────────────────────────────────────────────────────

const REPO = '0Chencc/clawgod';
const BADGES_JSON = `https://raw.githubusercontent.com/${REPO}/badges/claude-version.json`;

const installCommands = [
  {
    id: 'unix',
    label: 'macOS / Linux',
    prompt: '$ ',
    cmd: 'curl -fsSL https://github.com/0Chencc/clawgod/releases/latest/download/install.sh | bash',
  },
  {
    id: 'win',
    label: 'Windows (PowerShell)',
    prompt: '> ',
    cmd: 'irm https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1 | iex',
  },
];

const escape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/* ─── Shell tokenizer ───────────────────────────────────────────────
 * Split on whitespace while preserving it, then classify each non-
 * whitespace token by first-character heuristics. Good enough for the
 * curl/bash/irm/iex one-liners on this page; not a real shell parser. */

type TokenKind = 'space' | 'cmd' | 'arg' | 'flag' | 'url' | 'op';
interface Token { kind: TokenKind; text: string; }

const SHELL_OPS = new Set(['|', '||', '&&', ';', '&', '>', '>>', '<']);

const tokenize = (cmd: string): Token[] => {
  const out: Token[] = [];
  const parts = cmd.split(/(\s+)/);
  let firstWordSeen = false;
  let lastNonSpaceWasOp = false;

  for (const p of parts) {
    if (!p) continue;
    if (/^\s+$/.test(p)) {
      out.push({ kind: 'space', text: p });
      continue;
    }
    let kind: TokenKind;
    if (SHELL_OPS.has(p)) {
      kind = 'op';
    } else if (/^https?:\/\//.test(p)) {
      kind = 'url';
    } else if (/^-/.test(p)) {
      kind = 'flag';
    } else if (!firstWordSeen || lastNonSpaceWasOp) {
      // First non-whitespace word, OR first word after a pipe/op,
      // is the command being invoked.
      kind = 'cmd';
    } else {
      kind = 'arg';
    }
    out.push({ kind, text: p });
    firstWordSeen = true;
    lastNonSpaceWasOp = kind === 'op';
  }
  return out;
};

const renderCmd = (cmd: string): string =>
  tokenize(cmd)
    .map((t) =>
      t.kind === 'space'
        ? t.text
        : `<span class="tok tok-${t.kind}">${escape(t.text)}</span>`,
    )
    .join('');

const renderInstall = () => `
<section class="install">
  <div class="install-tabs" role="tablist">
    ${installCommands
      .map(
        (c, i) => `
      <button class="install-tab ${i === 0 ? 'active' : ''}" role="tab"
              data-target="${c.id}" aria-selected="${i === 0}">
        ${c.label}
      </button>`,
      )
      .join('')}
  </div>
  ${installCommands
    .map(
      (c, i) => `
    <div class="install-panel ${i === 0 ? 'active' : ''}" id="panel-${c.id}" role="tabpanel">
      <div class="code-block">
        <button class="copy-btn" data-copy="${escape(c.cmd)}">Copy</button>
        <pre><span class="prompt">${c.prompt}</span>${renderCmd(c.cmd)}</pre>
      </div>
      <div class="install-note">
        Idempotent — safe to re-run. ${c.id === 'win' ? 'Bun via <a href="https://bun.sh/install" target="_blank" rel="noopener">bun.sh</a> recommended.' : 'Bun, Node ≥ 18, ripgrep required.'}
      </div>
    </div>`,
    )
    .join('')}
</section>
`;

const renderSection = (s: (typeof sections)[number], i: number) => `
<section class="section" ${i === 0 ? 'id="patches"' : ''}>
  <header class="section-head">
    <h2><span class="num">${s.num}</span>${s.title}</h2>
    <p>${s.blurb}</p>
  </header>
  <div class="patches-grid">
    ${s.patches
      .map(
        (p) => `
      <article class="patch-card">
        <span class="badge ${p.kind}">${kindLabel(p.kind)}</span>
        <div class="name">${p.name}</div>
        <div class="desc">${p.desc}</div>
      </article>`,
      )
      .join('')}
  </div>
</section>
`;

const kindLabel = (k: PatchKind): string =>
  ({ unlock: 'Unlock', remove: 'Remove', visual: 'Visual', route: 'Routing' })[k];

const renderHowItWorks = () => `
<section class="section" id="how">
  <header class="section-head">
    <h2><span class="num">∞</span>How it works</h2>
    <p>Two-stage runtime patch. No fork, no compile.</p>
  </header>
  <div class="how-grid">
    <div class="how-card">
      <h3>Extract</h3>
      <p>The installer reads Anthropic's native binary, pulls out <code>cli.js</code> and embedded <code>.node</code> modules, and post-processes them for Bun-on-disk execution.</p>
    </div>
    <div class="how-card">
      <h3>Patch</h3>
      <p>A regex-only patcher rewrites the extracted <code>cli.js</code> in place — flipping gates, stripping refusals, re-coloring the brand. Idempotent and version-portable.</p>
    </div>
    <div class="how-card">
      <h3>Launch</h3>
      <p>A thin wrapper at <code>~/.local/bin/claude</code> spawns Bun against the patched <code>cli.original.cjs</code>, with <code>provider.json</code> deciding env injection.</p>
    </div>
    <div class="how-card">
      <h3>Stay current</h3>
      <p><code>claude update</code> is patched to route through this installer — pulls the latest Anthropic release from npm and re-patches, in one step.</p>
    </div>
  </div>
</section>
`;

const renderCta = () => `
<section class="cta">
  <div class="cta-row">
    <a class="btn primary" href="https://github.com/${REPO}#install">Get started</a>
    <a class="btn" href="https://github.com/${REPO}" target="_blank" rel="noopener">
      <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      Source on GitHub
    </a>
  </div>
</section>
`;

const ghIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

const xIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.294 6.776 14.357 1h-1.2L8.756 6.013 5.235 1H1.171l5.31 7.531L1.171 15h1.2l4.642-5.296L10.762 15h4.064L9.294 6.776Zm-1.643 1.872-.539-.755L2.804 1.91h1.844l3.452 4.847.539.755 4.49 6.301h-1.844L7.65 8.648Z"/></svg>`;

const starIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>`;

const downloadIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14H2.75Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 6.78a.75.75 0 0 1 1.06-1.06l1.97 1.969Z"/></svg>`;

const renderFooter = () => `
<footer class="footer">
  <div class="container footer-grid">
    <span class="footer-cell footer-license">
      GPL-3.0 · Not affiliated with Anthropic · Use at your own risk.
    </span>
    <span class="footer-cell footer-author">
      by
      <a href="https://github.com/0chencc" target="_blank" rel="noopener">@0chencc</a>
      <a class="icon-link" href="https://github.com/0chencc" target="_blank" rel="noopener" aria-label="GitHub: 0chencc">${ghIcon}</a>
      <a class="icon-link" href="https://x.com/0chencc"      target="_blank" rel="noopener" aria-label="X: 0chencc">${xIcon}</a>
    </span>
    <span class="footer-cell footer-links">
      <a href="https://github.com/${REPO}/releases">Releases</a> ·
      <a href="https://github.com/${REPO}/issues">Issues</a> ·
      <a href="https://github.com/${REPO}/actions/workflows/compat-daily.yml">CI</a>
    </span>
  </div>
</footer>
`;

const app = `
<header class="topbar">
  <div class="topbar-inner">
    <span class="brand">claw<span>god</span></span>
    <nav class="topbar-links">
      <a href="#patches">Patches</a>
      <a href="#how">How it works</a>
      <a href="https://github.com/${REPO}" target="_blank" rel="noopener">GitHub</a>
    </nav>
  </div>
</header>

<main class="container">
  <section class="hero">
    <div class="hero-meta" id="hero-meta">
      <span class="dot idle"></span>
      <span id="hero-meta-text">Loading verified version…</span>
    </div>
    <h1>claw<span class="accent">god</span></h1>
    <p class="tagline">God mode for Claude Code.</p>
    <p class="sub">
      Unlock internal features. Remove restrictions. Re-color the brand.<br />
      One command, no compile.
    </p>
    <div class="hero-links">
      <a class="hero-link author-gh" href="https://github.com/0chencc"
         target="_blank" rel="noopener">${ghIcon} <span>@0chencc</span></a>
      <a class="hero-link author-x" href="https://x.com/0chencc"
         target="_blank" rel="noopener">${xIcon} <span>@0chencc</span></a>
      <a class="hero-link stars" href="https://github.com/${REPO}/stargazers"
         target="_blank" rel="noopener">${starIcon}
         <span class="stat-num loading" id="stat-stars">—</span>
         <span>stars</span></a>
      <a class="hero-link downloads" href="https://github.com/${REPO}/releases"
         target="_blank" rel="noopener">${downloadIcon}
         <span class="stat-num loading" id="stat-downloads">—</span>
         <span>downloads</span></a>
    </div>
  </section>

  ${renderInstall()}

  <div class="screenshot">
    <img src="bypass.png" alt="ClawGod-patched Claude Code, green logo and theme" />
    <p class="caption">
      <span class="green-sq">█</span> patched &nbsp;·&nbsp;
      <span class="orange-sq">█</span> original
    </p>
  </div>

  ${sections.map(renderSection).join('')}
  ${renderHowItWorks()}
  ${renderCta()}
</main>

${renderFooter()}
`;

// ─── Mount ──────────────────────────────────────────────────────────

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
root.innerHTML = app;

// ─── Tab switching ──────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>('.install-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.target;
    if (!target) return;
    document.querySelectorAll('.install-tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    document.querySelectorAll('.install-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `panel-${target}`);
    });
  });
});

// ─── Copy buttons ───────────────────────────────────────────────────

/* Two-tier copy: prefer the modern Clipboard API (only available in
 * secure contexts — https or http://localhost), fall back to the
 * legacy `document.execCommand('copy')` via a hidden textarea so this
 * keeps working when the dev server is reached over LAN IP, intranet
 * deployments behind plain http, etc. */
async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText =
    'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

document.querySelectorAll<HTMLButtonElement>('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const text = btn.dataset.copy;
    if (!text) return;
    const orig = btn.textContent ?? 'Copy';
    const ok = await copyText(text);
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    btn.classList.toggle('copied', ok);
    btn.classList.toggle('failed', !ok);
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('copied', 'failed');
    }, 1800);
  });
});

// ─── Topbar shadow on scroll ────────────────────────────────────────

const topbar = document.querySelector<HTMLElement>('.topbar');
if (topbar) {
  const onScroll = () => topbar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// ─── Live "Claude tested" pill ──────────────────────────────────────
// Reads the same JSON the README badge consumes — single source of
// truth for "what version is currently verified by daily CI".

interface BadgeJson {
  schemaVersion: number;
  label: string;
  message: string;
  color: string;
}

(async () => {
  const meta = document.getElementById('hero-meta');
  const dot = meta?.querySelector<HTMLElement>('.dot');
  const text = document.getElementById('hero-meta-text');
  if (!meta || !dot || !text) return;

  try {
    const res = await fetch(BADGES_JSON, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as BadgeJson;
    if (!data.message) throw new Error('no version');
    dot.classList.remove('idle');
    text.innerHTML = `Verified on Claude Code <strong style="color: var(--text)">${escape(data.message)}</strong>`;
    meta.title = 'Refreshed daily by .github/workflows/compat-daily.yml';
  } catch {
    // Branch not yet populated (first deploy) or network down: stay quiet.
    dot.classList.add('idle');
    text.textContent = 'Daily compat verified';
    meta.title = 'See GitHub Actions for the latest verified version';
  }
})();

/* ─── Live repo stats (stars + total downloads) ─────────────────────
 * Two parallel requests against GitHub's public REST API. Unauthed
 * limit is 60/hr per IP, plenty for a static landing page. */

const formatCount = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
};

const setStat = (id: string, n: number | null) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('loading');
  el.textContent = n == null ? '—' : formatCount(n);
};

(async () => {
  const headers = { Accept: 'application/vnd.github+json' };
  await Promise.all([
    fetch(`https://api.github.com/repos/${REPO}`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setStat('stat-stars', j?.stargazers_count ?? null))
      .catch(() => setStat('stat-stars', null)),

    // Sum download_count across every asset of every release.
    fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((releases: { assets?: { download_count: number }[] }[] | null) => {
        if (!releases) return setStat('stat-downloads', null);
        let total = 0;
        for (const r of releases) for (const a of r.assets ?? []) total += a.download_count;
        setStat('stat-downloads', total);
      })
      .catch(() => setStat('stat-downloads', null)),
  ]);
})();
