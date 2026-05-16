/* Progressive enhancement only.
 * The HTML in index.html is fully written out at build time so the
 * page paints completely on first frame — no client-side rendering
 * step that would make the hero h1 "appear" after a JS turn. This
 * file's job is purely:
 *   - tab switching for the install widget
 *   - copy-to-clipboard with secure-context fallback
 *   - sticky-topbar shadow on scroll
 *   - hydrate the verified-version pill from the daily-CI badge JSON
 *   - hydrate the GitHub stargazer + total-download chips
 *
 * Note: CSS is intentionally NOT imported here. It's loaded as a
 * <link rel="stylesheet"> in index.html so it arrives synchronously
 * with the HTML — importing CSS through this module would chain it
 * behind the deferred JS fetch and cause a Flash of Unstyled Content.
 */

const REPO = 'gdlwolf/clawgod';
const BADGES_JSON = `https://raw.githubusercontent.com/${REPO}/badges/claude-version.json`;

const escape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/* ─── Install widget tabs ───────────────────────────────────────── */

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

/* ─── Copy buttons ──────────────────────────────────────────────── */
/* Two-tier: prefer the modern Clipboard API (only available in
 * secure contexts — https or http://localhost), fall back to the
 * legacy `document.execCommand('copy')` via a hidden textarea so
 * this keeps working over LAN IP / plain http intranet deployments. */

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

/* ─── Sticky topbar ─────────────────────────────────────────────── */

const topbar = document.querySelector<HTMLElement>('.topbar');
if (topbar) {
  const onScroll = () => topbar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ─── Live "Claude tested" pill ─────────────────────────────────── */
/* Reads the same JSON the README badge consumes. Single source of
 * truth for "what version is currently verified by daily CI". */

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
  } catch {
    /* Branch not yet populated (first deploy) or network down — keep
     * the static fallback "Daily compat verified" already in the HTML. */
  }
})();

/* ─── Live repo stats (stars + total downloads) ─────────────────── */
/* Two parallel requests against GitHub's public REST API. Unauthed
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
