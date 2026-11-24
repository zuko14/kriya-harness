#!/bin/sh
# Kriya Harness installer (S-2, Kriya-Tavi docs/kriya-harness/INSTALLER.md).
#
#   curl -fsSL https://<your Kriya>/install.sh | sh
#
# Installs a private Node runtime and Kriya Harness under ~/.kriya (nothing
# global: not your Node, npm, nvm or /usr/local), puts `kriya` on your PATH,
# and opens the sign-in for the Kriya that served this script. Run it again
# to repair or update. Your sign-in, sessions and settings in ~/.kriya stay.
#
# Settings (environment): KRIYA_HOME (default ~/.kriya), KRIYA_NO_MODIFY_PATH=1
# (don't edit your shell's startup file), KRIYA_NO_LOGIN=1 (don't sign in now).
#
# Everything runs inside main, called on the last line, so a download cut off
# halfway runs nothing.

set -eu

KRIYA_VERSION="2.1.1"
NODE_VERSION="24.22.0"
# The Kriya that served this script fills this in; left as is, no sign-in is started
KRIYA_URL_DEFAULT="__KRIYA_URL__"

# sha256 of each Node release file, from https://nodejs.org/dist/v24.22.0/SHASUMS256.txt
node_sha256() {
  case "$1" in
    darwin-arm64) echo "6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5" ;;
    darwin-x64) echo "495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91" ;;
    linux-arm64) echo "b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d" ;;
    linux-x64) echo "28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c" ;;
    *) return 1 ;;
  esac
}

say() { printf 'kriya: %s\n' "$*"; }
fail() {
  printf 'kriya: %s\n' "$*" >&2
  exit 1
}

platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN* | Windows*) fail "Windows: run this inside WSL (wsl --install), then again in its terminal." ;;
    *) fail "Kriya Harness runs on macOS and Linux; this is $os." ;;
  esac
  case "$arch" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail "No Kriya Harness build for $arch processors yet." ;;
  esac
  echo "$os-$arch"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    fail "Need shasum or sha256sum to check the download."
  fi
}

install_node() {
  target=$1
  dir="$KRIYA_HOME/runtime/node-v$NODE_VERSION-$target"
  if [ -x "$dir/bin/node" ]; then
    NODE_DIR=$dir
    return
  fi
  expected=$(node_sha256 "$target") || fail "No Node build for $target."
  file="node-v$NODE_VERSION-$target.tar.gz"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/kriya-install.XXXXXX")
  say "Downloading Node $NODE_VERSION (a private copy for Kriya Harness)…"
  curl -fsSL --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v$NODE_VERSION/$file" -o "$tmp/$file" ||
    { rm -rf "$tmp"; fail "Couldn't download Node from nodejs.org; check your connection and run this again."; }
  actual=$(sha256_of "$tmp/$file")
  if [ "$actual" != "$expected" ]; then
    rm -rf "$tmp"
    fail "The Node download didn't match its published checksum; nothing was installed."
  fi
  tar -xzf "$tmp/$file" -C "$tmp" || { rm -rf "$tmp"; fail "Couldn't unpack Node."; }
  mkdir -p "$KRIYA_HOME/runtime"
  rm -rf "$dir"
  mv "$tmp/node-v$NODE_VERSION-$target" "$dir"
  rm -rf "$tmp"
  NODE_DIR=$dir
}

install_kriya() {
  say "Installing Kriya Harness $KRIYA_VERSION…"
  # The private npm, with the private node first on PATH for any install script
  PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install --global --prefix "$KRIYA_HOME/npm" \
    --no-fund --no-audit --loglevel=error "@kriya-ai/harness@$KRIYA_VERSION" ||
    fail "npm couldn't install Kriya Harness; run this again, or see https://docs.npmjs.com/common-errors."
  entry="$KRIYA_HOME/npm/lib/node_modules/@kriya-ai/harness/bin/kriya.js"
  [ -f "$entry" ] || fail "The install finished without Kriya Harness's entry point."
  mkdir -p "$KRIYA_HOME/bin"
  # Written fresh each time, so a repair points at this runtime
  cat >"$KRIYA_HOME/bin/kriya.tmp" <<EOF
#!/bin/sh
# Kriya Harness, with its private Node (written by install.sh)
KRIYA_HOME="\${KRIYA_HOME:-$KRIYA_HOME}"
export KRIYA_HOME
exec "$NODE_DIR/bin/node" "$entry" "\$@"
EOF
  chmod 755 "$KRIYA_HOME/bin/kriya.tmp"
  mv "$KRIYA_HOME/bin/kriya.tmp" "$KRIYA_HOME/bin/kriya"
}

add_to_path() {
  bin="$KRIYA_HOME/bin"
  case ":$PATH:" in *":$bin:"*) return ;; esac
  if [ "${KRIYA_NO_MODIFY_PATH:-}" = "1" ]; then
    say "Add Kriya Harness to your PATH: export PATH=\"$bin:\$PATH\""
    return
  fi
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" ;;
    */bash) if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    */fish) rc="" ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -z "$rc" ]; then
    say "Add Kriya Harness to your PATH: fish_add_path $bin"
    return
  fi
  if [ -f "$rc" ] && grep -q '# Kriya Harness (install.sh)' "$rc"; then
    :
  else
    printf '\n# Kriya Harness (install.sh)\nexport PATH="%s:$PATH"\n' "$bin" >>"$rc"
    say "Added $bin to your PATH in $rc."
  fi
  ADDED_PATH=1
}

sign_in() {
  url="${KRIYA_URL:-$KRIYA_URL_DEFAULT}"
  case "$url" in
    https://* | http://127.0.0.1:* | http://localhost:*) ;;
    *) return ;;
  esac
  if [ -f "$KRIYA_HOME/device.json" ]; then
    say "Already signed in on this computer; kriya login --url $url switches accounts."
    return
  fi
  if [ "${KRIYA_NO_LOGIN:-}" = "1" ]; then
    say "Sign in when you're ready: kriya login --url $url"
    return
  fi
  say "Signing in to $url…"
  # Never the script's own pipe as input
  # /dev/tty can exist yet fail to open (no terminal: CI, some IDE consoles)
  if { true </dev/tty; } 2>/dev/null; then
    "$KRIYA_HOME/bin/kriya" login --url "$url" </dev/tty || say "Sign in later with: kriya login --url $url"
  else
    "$KRIYA_HOME/bin/kriya" login --url "$url" </dev/null || say "Sign in later with: kriya login --url $url"
  fi
}

main() {
  [ -n "${HOME:-}" ] || fail "HOME isn't set."
  command -v curl >/dev/null 2>&1 || fail "Need curl."
  command -v tar >/dev/null 2>&1 || fail "Need tar."
  KRIYA_HOME="${KRIYA_HOME:-$HOME/.kriya}"
  # Private, as kriya keeps it (src/store.js ensureHome): the sign-in lives here
  mkdir -p "$KRIYA_HOME"
  chmod 700 "$KRIYA_HOME"
  ADDED_PATH=0
  target=$(platform)
  install_node "$target"
  install_kriya
  add_to_path
  sign_in
  say "Done. Kriya Harness $KRIYA_VERSION is installed."
  if [ "$ADDED_PATH" = 1 ]; then
    say "Open a new terminal (or run: export PATH=\"$KRIYA_HOME/bin:\$PATH\"), then: cd your-project && kriya"
  else
    say "Next: cd your-project && kriya"
  fi
}

main "$@"
