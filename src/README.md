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

## Layout

- `shared/` contains payloads embedded identically in both installers.
  `feature-gates.cjs` carries a `{{CLAWGOD:FEATURES_META}}` marker that
  build.js replaces with the inverted FEATURES registry from patch.mjs.
- `unix/` and `windows/` contain genuinely platform-specific payloads.
- `templates/` contain the shell around those payloads and use
  `{{CLAWGOD:<installed-name>}}` placeholders.

The PowerShell template and generated installer are intentionally BOM-free and
ASCII-only. This keeps both direct Windows PowerShell 5.1 execution and the
documented `irm ... | iex` path independent of the machine's active code page.
`build.js` escapes Unicode in embedded JavaScript/JSON payloads as `\uXXXX`.

Do not edit the generated installers directly. If an emergency fix starts in a
generated file, port it to the corresponding source/template immediately and
run the build before committing.
