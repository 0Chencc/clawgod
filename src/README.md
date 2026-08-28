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
- `unix/` and `windows/` contain genuinely platform-specific payloads.
- `templates/` contain the shell around those payloads and use
  `{{CLAWGOD:<installed-name>}}` placeholders.

The PowerShell template intentionally has no byte-order mark. `build.js` owns
output encoding and always adds the UTF-8 BOM required by Windows PowerShell
5.1 to the generated `install.ps1`.

Do not edit the generated installers directly. If an emergency fix starts in a
generated file, port it to the corresponding source/template immediately and
run the build before committing.
