#!/usr/bin/env bash
# Verifies the git-URL install path end to end without touching your global npm:
#   npm run verify:git-install        (or: bash scripts/verify-git-install.sh)
# Clones the current checkout (committed HEAD plus uncommitted and untracked, non-ignored changes)
# into a temp dir, commits it, runs `npm install -g --prefix <tmp> git+file://<clone>` (the same code
# path as `npm install -g github:antoniibelyshev/minions`), and checks the installed binary and
# runtime assets. Then reinstalls after `npm uninstall -g` (the documented upgrade path).
# Uses --prefer-offline, so it needs no network when the npm cache already holds the devDependencies.
# Set VERIFY_KEEP=1 to keep the temp dir. Set VERIFY_TMPDIR to choose where it goes (must allow exec).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${VERIFY_TMPDIR:-${TMPDIR:-/tmp}}"
mkdir -p "$BASE"
WORK="$(mktemp -d "$BASE/minions-git-install.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
SRC="$WORK/src"
PREFIX="$WORK/prefix"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ok: %s\n' "$*" >&2; }
cleanup() {
  local code=$?
  if [ "${VERIFY_KEEP:-}" = 1 ]; then printf 'Kept %s\n' "$WORK" >&2; else rm -rf "$WORK"; fi
  [ "$code" = 0 ] && printf 'GIT INSTALL VERIFIED\n' >&2 || printf 'GIT INSTALL FAILED (exit %s)\n' "$code" >&2
  exit "$code"
}
trap cleanup EXIT

printf '==> Cloning %s into %s\n' "$ROOT" "$SRC" >&2
git clone -q "$ROOT" "$SRC"
# Overlay working-tree changes so uncommitted work is verified too.
(cd "$ROOT" && git ls-files -z --modified --others --exclude-standard) | while IFS= read -r -d '' f; do
  if [ -e "$ROOT/$f" ]; then mkdir -p "$SRC/$(dirname "$f")" && cp -p "$ROOT/$f" "$SRC/$f"; else rm -f "$SRC/$f"; fi
done
(cd "$SRC" && git add -A && git -c user.name=verify -c user.email=verify@example.invalid commit -qm verify --allow-empty)

install() {
  # cd away from the checkout so its package.json/.npmrc cannot influence the install.
  (cd "$WORK" && npm install -g --prefix "$PREFIX" --no-fund --no-audit --prefer-offline "git+file://$SRC")
}
check() {
  local pkg="$PREFIX/lib/node_modules/minions"
  [ -d "$pkg" ] && [ ! -L "$pkg" ] || fail "$pkg is missing or a symlink"
  local v; v="$("$PREFIX/bin/minions" --version)" || fail "minions --version failed"
  local want; want="$(node -p 'require(process.argv[1]).version' "$SRC/package.json")"
  [ "$v" = "$want" ] || fail "minions --version printed '$v', expected '$want'"
  ok "minions --version = $v"
  for f in dist/cli.js package.json docker/Dockerfile docker/gh-wrapper.sh schema/config.schema.json templates/plugin; do
    [ -e "$pkg/$f" ] || fail "installed package lacks $f"
  done
  ok "runtime assets present (dist, docker, schema, templates)"
  "$PREFIX/bin/minions" setup --help >/dev/null || fail "minions setup --help failed"
  ok "minions setup --help"
}

printf '==> npm install -g git+file://… (clean prefix)\n' >&2
install
check
printf '==> npm uninstall -g minions, then install again (upgrade path)\n' >&2
(cd "$WORK" && npm uninstall -g --prefix "$PREFIX" --no-fund --no-audit minions >/dev/null)
install
check
