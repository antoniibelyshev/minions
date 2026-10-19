#!/bin/sh
# minions gh wrapper, installed as /usr/local/bin/gh (the real binary is /opt/gh/bin/gh, off PATH).
# Reads the mounted GitHub token at exec time and passes it to gh as GH_TOKEN in gh's own
# environment only: nothing is written to gh's config, tmux, settings files, or the caller's env.
# The token file may be absent (no credential: gh runs unauthenticated) or replaced at any time.
set -u
REAL_GH=/opt/gh/bin/gh
TOKEN_FILE=/opt/minions/secrets/github-token

if [ -e "$TOKEN_FILE" ]; then
  if [ ! -r "$TOKEN_FILE" ]; then
    echo "minions: GitHub token file $TOKEN_FILE is not readable by container uid $(id -u)." >&2
    echo "minions: on a Linux Docker Engine host the 0600 token file must be owned by uid 1000 (the container user); run minions as a host user with uid 1000." >&2
    exit 4
  fi
  # $(...) drops trailing newlines; anything else must be a GitHub token shape (no spaces/quotes).
  token=$(cat "$TOKEN_FILE") || exit 4
  case "$token" in
    '') ;;
    github_pat_*|ghp_*|gho_*|ghu_*|ghs_*|ghr_*)
      case "$token" in
        *[!A-Za-z0-9_]*) echo "minions: $TOKEN_FILE does not contain a GitHub token; re-provision with \`minions auth github\` on the host." >&2; exit 4 ;;
      esac
      GH_TOKEN=$token
      export GH_TOKEN
      ;;
    *) echo "minions: $TOKEN_FILE does not contain a GitHub token; re-provision with \`minions auth github\` on the host." >&2; exit 4 ;;
  esac
  unset token
fi
GH_NO_UPDATE_NOTIFIER=1
export GH_NO_UPDATE_NOTIFIER
exec "$REAL_GH" "$@"
