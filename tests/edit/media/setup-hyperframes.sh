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
