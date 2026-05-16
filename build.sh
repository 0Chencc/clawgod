#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
#  ClawGod Build — regenerate install.sh from src/ files
#
#  Usage:
#    bash build.sh
#
#  What it does:
#    Replaces every heredoc-embedded file in install.sh
#    (extract-natives.mjs, post-process.mjs, repatch.mjs,
#     cli.cjs, patch.mjs, features.json) with the latest
#    version from src/.  Run this after editing any src/ file
#    before committing, so that users running install.sh
#    get the same code you developed locally.
# ─────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$HERE/install.sh"
SRC="$HERE/src"

if [ ! -f "$INSTALL" ]; then
  echo "❌ install.sh not found at $INSTALL" >&2
  exit 1
fi

if [ ! -d "$SRC" ]; then
  echo "❌ src/ directory not found at $SRC" >&2
  exit 1
fi

# ─── Build ──────────────────────────────────────────────

node -e '
const fs = require("fs");
const path = require("path");

const HERE = process.argv[1];

const pairs = [
  ["EXTRACTOR_EOF", "extract-natives.mjs"],
  ["POSTPROC_EOF",  "post-process.mjs"],
  ["REPATCH_EOF",   "repatch.mjs"],
  ["WRAPPER_EOF",   "cli.cjs"],
  ["PATCHER_EOF",   "patch.mjs"],
  ["FEATURES_EOF",  "features.json"],
];

let install = fs.readFileSync(path.join(HERE, "install.sh"), "utf8");

for (const [marker, filename] of pairs) {
  const srcPath = path.join(HERE, "src", filename);
  if (!fs.existsSync(srcPath)) {
    console.error("  ⚠️  Missing: src/" + filename + " — skipping");
    continue;
  }

  let content = fs.readFileSync(srcPath, "utf8");
  // Ensure trailing newline (heredoc marker must be on its own line)
  if (!content.endsWith("\n")) content += "\n";

  // Match:  cat > ... << '\''MARKER'\''\n
  const startRe = new RegExp(
    "cat\\s+>.*<<\\s+'\''" + marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "'\''\\n"
  );
  const endStr = "\n" + marker;

  const startMatch = install.match(startRe);
  if (!startMatch) {
    console.error("  ❌ Start marker not found: " + marker);
    process.exit(1);
  }

  const startIdx = startMatch.index + startMatch[0].length;
  const endIdx = install.indexOf(endStr, startIdx);

  if (endIdx === -1) {
    console.error("  ❌ Closing marker not found: " + marker);
    process.exit(1);
  }

  install = install.slice(0, startIdx) + content + install.slice(endIdx);
  console.log("  ✅ " + filename + "  →  install.sh");
}

fs.writeFileSync(path.join(HERE, "install.sh"), install);
' "$HERE"

echo ""
echo "  ✅ install.sh regenerated"
echo ""
echo "  Next steps:"
echo "    git diff install.sh          # review changes"
echo "    git add install.sh build.sh  # commit both"
