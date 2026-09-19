# Installer build sources

`install.sh` and `install.ps1` are generated, committed release artifacts.
Edit the files under this directory, then rebuild from the repository root:

```bash
node build.js
node build.js --check
```

The build must remain byte-for-byte reproducible. CI runs `--check` and fails
when either generated installer is missing or differs from its sources.
`.gitattributes` pins the complete build graph to LF on every platform.

## Testing

`src/shared/patch.test.mjs` tests the classifier-timeout helper in
`runtime-helpers.cjs` and runs the patcher on Ultraplan fixtures for legacy
bundles and chunk graphs. It checks runtime toggles, metadata preservation,
and rejection of unsupported shapes without changing neighboring commands.
No Claude bundle is needed. Run locally with Node:

```bash
node src/shared/patch.test.mjs
```

`src/shared/bun-ant-shim.test.mjs` tests the `Bun.ant.CellSegmenter`
implementation in `bun-ant-shim.cjs`: escape scanning, grapheme widths, style
runs, hyperlink runs, capacity reporting, and the cell/damage packing that the
patched bundle reads back. It runs under plain Node as well, because the shim
falls back to a local width table when `Bun.stringWidth` is unavailable:

```bash
node src/shared/bun-ant-shim.test.mjs
```

`src/shared/terminal-reply.test.mjs` checks the incomplete DA1 reply timer,
normal keyboard/paste fallback, its two-second timeout, and the actual patch
composition for legacy bundles and chunk graphs:

```bash
node src/shared/terminal-reply.test.mjs
```

While a terminal probe is pending, a lone Escape or Alt+[ may wait up to two
seconds for a reply continuation before the original parser handles it. With
no outstanding probe, the original input timing is unchanged.

`src/shared/lean.test.mjs` exercises the full launcher with isolated settings,
plus the Unix and Windows installer settings scripts. It covers on/max/off
transitions, old Remote Control settings migration, PowerShell Boolean casing,
provider parity, and preservation of explicit network environment settings:

```bash
node src/shared/lean.test.mjs
```

CI runs all four suites in the `build-sources` job, then loads the shim under Bun in the
smoke jobs (`compat-daily.yml`).

`src/ci/tui-smoke.py` tests an installed CLI in a POSIX PTY or Windows ConPTY.
It uses isolated configuration and a local mock API, types a prompt, and
checks the rendered screen for the reply. Install its Python dependencies
from `src/ci/tui-requirements.txt`. Windows CI runs it against both the latest
Claude/Bun canary and Claude 2.1.272/Bun 1.4.2; the pinned case must also
reproduce the missing CellSegmenter error with the shim disabled. Terminal
logs, final screens and results are uploaded as CI artifacts.

## Layout

- `shared/` contains payloads embedded identically in both installers,
  including `cli.cjs` (the launcher/patcher bootstrap shared by Unix and
  Windows). `feature-gates.cjs` carries a `{{CLAWGOD:FEATURES_META}}` marker
  that build.js replaces with the inverted FEATURES registry from patch.mjs.
  `bun-ant-shim.cjs` re-implements the `Bun.ant.CellSegmenter` API that Claude
  Code 2.1.271+ renders through, since stock Bun has no `Bun.ant` namespace;
  `cli.cjs` loads it before `cli.original.cjs`.
- `windows/` contains genuinely platform-specific payloads (the PowerShell
  build applies `escapeNonAscii` per file in build.js).
- `templates/` contain the shell around those payloads and use
  `{{CLAWGOD:<installed-name>}}` placeholders.

The PowerShell template and generated installer are intentionally BOM-free and
ASCII-only. This keeps both direct Windows PowerShell 5.1 execution and the
documented `irm ... | iex` path independent of the machine's active code page.
`build.js` escapes Unicode in embedded JavaScript/JSON payloads as `\uXXXX`.

Do not edit the generated installers directly. If an emergency fix starts in a
generated file, port it to the corresponding source/template immediately and
run the build before committing.
