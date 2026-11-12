#!/bin/sh
# One-time setup for the motion media tests (ED8), until a signed Media Runtime
# version brings HyperFrames (EB-09). Installs the pinned HyperFrames CLI with no
# install scripts, and the manifest's chrome-headless-shell, under ~/.cache.
set -eu
HF="${KRIYA_EDIT_HYPERFRAMES:-$HOME/.cache/kriya-edit-test/hyperframes-0.9.20}"
mkdir -p "$HF"
cd "$HF"
[ -f package.json ] || printf '{"private":true}\n' > package.json
PUPPETEER_SKIP_DOWNLOAD=1 npm install --ignore-scripts --no-audit --no-fund --save-exact hyperframes@0.9.20
"$HF/node_modules/.bin/browsers" install chrome-headless-shell@152.0.7977.30 --path "$HOME/.cache/kriya-edit-test/chrome"
# TP7: the font pack's files (tests/edit/runtime-2026.11.1.json), each kept only if its sha256 matches
FONTS="$HOME/.cache/kriya-edit-test/fonts"
mkdir -p "$FONTS"
node -e '
const m = require(process.argv[1])
for (const a of m.platforms["darwin-arm64"].packs["pack-fonts"].artifacts) console.log(a.sha256 + " " + a.url)
' "$(cd "$(dirname "$0")/.." && pwd)/runtime-2026.11.1.json" | while read -r sha url; do
  [ -f "$FONTS/$sha.ttf" ] && continue
  curl -fsSL "$url" -o "$FONTS/$sha.part"
  [ "$(shasum -a 256 "$FONTS/$sha.part" | cut -d" " -f1)" = "$sha" ] && mv "$FONTS/$sha.part" "$FONTS/$sha.ttf" || { rm -f "$FONTS/$sha.part"; echo "hash mismatch: $url" >&2; exit 1; }
done
