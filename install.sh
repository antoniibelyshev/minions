#!/usr/bin/env bash
# One-command bootstrap for minions from a source checkout:
#   ./install.sh [path-to-your-repo] [minions setup options, e.g. --private --yes]
# Builds the package, installs it GLOBALLY with npm (npm install -g), then runs `minions setup`.
# It does not edit shell rc files and does not download and execute remote scripts.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-.}"
[ "$#" -gt 0 ] && shift

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*" >&2; }

os="$(uname -s)"
case "$os" in
  Darwin) ;;
  Linux) info "note: Linux support (Docker Engine) is new; live validation is pending. Run 'minions doctor' for exact fixes. See docs/compatibility.md." ;;
  *) info "warning: minions v0.1 supports macOS and Linux only (found $os)." ;;
esac

command -v node >/dev/null 2>&1 || die "Node.js >= 22.13 is required (https://nodejs.org)."
node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  process.exit(maj > 22 || (maj === 22 && min >= 13) ? 0 : 1);
' || die "Node.js >= 22.13 is required (found $(node --version))."
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

if [ "$os" = "Linux" ]; then
  command -v docker >/dev/null 2>&1 || die "Docker is required. Install Docker Engine: https://docs.docker.com/engine/install/"
  if ! docker_err="$(docker info 2>&1 >/dev/null)"; then
    case "$docker_err" in
      *"permission denied"*) die "Your user cannot open the Docker socket. Add it to the docker group (root-equivalent): sudo usermod -aG docker \"\$USER\", then log out and back in; or use rootless Docker (https://docs.docker.com/engine/security/rootless/) with DOCKER_HOST set." ;;
      *) die "Docker is installed but not reachable. Start Docker Engine (sudo systemctl enable --now docker, or systemctl --user start docker for rootless Docker), then rerun ./install.sh." ;;
    esac
  fi
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required: sudo apt-get install docker-compose-plugin (Debian/Ubuntu) or sudo dnf install docker-compose-plugin (Fedora/RHEL)."
else
  command -v docker >/dev/null 2>&1 || die "Docker is required. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed but not running. Start Docker Desktop, wait until it is ready, then rerun ./install.sh."
  fi
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (bundled with Docker Desktop)."
fi

cd "$here"
# Stamps dist/build.json as a packed install, so `minions upgrade` may later reinstall it in place.
export MINIONS_BUILD_KIND=packed
info "Installing build dependencies (npm ci)"
npm ci --no-fund --no-audit
info "Building"
npm run build
info "Packing"
tgz="$(npm pack --silent | tail -n 1)"
[ -f "$tgz" ] || die "npm pack did not produce a tarball."

info "Installing $tgz globally with npm (npm install -g). Remove later with: npm uninstall -g minions"
npm install -g --no-fund --no-audit "./$tgz"
command -v minions >/dev/null 2>&1 || die "minions is not on PATH; add \"$(npm prefix -g)/bin\" to your PATH, then run: minions setup \"$target\""

cd - >/dev/null
info "Running: minions setup $target $*"
exec minions setup "$target" "$@"
