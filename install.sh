#!/usr/bin/env bash
# One-command bootstrap for minions from a source checkout:
#   ./install.sh [path-to-your-repo]
# Builds the package, installs it GLOBALLY with npm (npm install -g), then runs `minions init`.
# It does not edit shell rc files and does not download and execute remote scripts.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-.}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*" >&2; }

[ "$(uname -s)" = "Darwin" ] || info "warning: minions v0.1 is tested on macOS only."

command -v node >/dev/null 2>&1 || die "Node.js >= 22.13 is required (https://nodejs.org)."
node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  process.exit(maj > 22 || (maj === 22 && min >= 13) ? 0 : 1);
' || die "Node.js >= 22.13 is required (found $(node --version))."
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

command -v docker >/dev/null 2>&1 || die "Docker is required. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
if ! docker info >/dev/null 2>&1; then
  die "Docker is installed but not running. Start Docker Desktop, wait until it is ready, then rerun ./install.sh."
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (bundled with Docker Desktop)."

cd "$here"
info "Installing build dependencies (npm ci)"
npm ci --no-fund --no-audit
info "Building"
npm run build
info "Packing"
tgz="$(npm pack --silent | tail -n 1)"
[ -f "$tgz" ] || die "npm pack did not produce a tarball."

info "Installing $tgz globally with npm (npm install -g). Remove later with: npm uninstall -g minions"
npm install -g --no-fund --no-audit "./$tgz"
command -v minions >/dev/null 2>&1 || die "minions is not on PATH; add \"$(npm prefix -g)/bin\" to your PATH, then run: minions init \"$target\""

cd - >/dev/null
info "Running: minions init $target"
exec minions init "$target"
