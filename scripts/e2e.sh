#!/usr/bin/env bash
# Opt-in end-to-end test of the terminal workflow (no Claude login, no API calls).
#   npm run e2e            (needs Docker Desktop running)
# Builds and packs the package, installs it into a temp npm prefix, and drives `minions` against
# disposable Git repos with a temp MINIONS_HOME. Every container, volume and temp dir it creates is
# removed on exit. The runtime image minions-runtime:<version> is built (or rebuilt when stale) and kept.
# Set E2E_KEEP=1 to keep the temp dir and Docker resources for debugging.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/minions-e2e.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
export MINIONS_HOME="$WORK/home"
PREFIX="$WORK/prefix"
M="$PREFIX/node_modules/.bin/minions"
PROJECT_IDS=()
SERVER_PID=""

step() { printf '\n==> %s\n' "$*" >&2; }
ok() { printf '  ok: %s\n' "$*" >&2; }
fail() { printf '  FAIL: %s\n' "$*" >&2; exit 1; }
# json <expr>: evaluates a JS expression over the parsed stdin JSON bound to `d`.
json() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const v=(0,eval)("(d)=>("+process.argv[1]+")")(d);process.stdout.write(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }
expect_eq() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; ok "$3"; }

cleanup() {
  local code=$?
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" >/dev/null 2>&1 || true
  if [ "${E2E_KEEP:-}" = 1 ]; then printf '\nKept %s (MINIONS_HOME=%s)\n' "$WORK" "$MINIONS_HOME" >&2; exit "$code"; fi
  for id in "${PROJECT_IDS[@]+"${PROJECT_IDS[@]}"}"; do
    local f="$MINIONS_HOME/projects/$id/compose.yaml"
    [ -f "$f" ] && docker compose -f "$f" down -v --remove-orphans >/dev/null 2>&1 || true
    local short="${id:0:8}"
    docker rm -f "minions-$short-app-1" >/dev/null 2>&1 || true
    for v in workspace state claude cache; do docker volume rm "minions-$short-$v" >/dev/null 2>&1 || true; done
    docker network rm "minions-${short}_default" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
  [ "$code" = 0 ] && printf '\nE2E PASSED\n' >&2 || printf '\nE2E FAILED (exit %s)\n' "$code" >&2
  exit "$code"
}
trap cleanup EXIT

command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "Docker is not running; skipping e2e." >&2; exit 1; }

step "Build, pack, install into a temp prefix"
(cd "$ROOT" && npm run --silent build && npm pack --silent --pack-destination "$WORK" >/dev/null)
npm install --silent --no-fund --no-audit --prefix "$PREFIX" "$WORK"/minions-*.tgz
ok "minions $("$M" --version)"

make_repo() {
  mkdir -p "$1" && cd "$1"
  git init -q -b main
  git config user.name "E2E User" && git config user.email e2e@example.com
  printf '{"name":"demo","version":"1.0.0","scripts":{"test":"node -e \\"console.log(1)\\""}}\n' > package.json
  printf '.env\n' > .gitignore
  printf 'FAKE_SECRET=do-not-import\n' > .env
  printf '# demo\n' > README.md
  git add -A && git commit -qm init
  cd - >/dev/null
}
A="$WORK/private-repo"; B="$WORK/shared-repo"
make_repo "$A"; make_repo "$B"

step "init (private), idempotent rerun, config, doctor"
before="$(git -C "$A" status --porcelain)"
out="$("$M" init "$A" --yes --private --json)"
ID_A="$(json 'd.data.plan.projectId' <<<"$out")"; PROJECT_IDS+=("$ID_A")
expect_eq "$(git -C "$A" status --porcelain)" "$before" "private init leaves git status unchanged"
expect_eq "$("$M" init "$A" --yes --private --json | json 'd.data.applied.written.length')" 0 "rerun writes nothing"
cd "$A"
"$M" config show --explain | grep -q '^capabilities.code.edit = {' || fail "config show --explain resolves dotted capability keys"
ok "config show --explain"
doc="$("$M" doctor --json)"
expect_eq "$(json 'd.ok' <<<"$doc")" true "doctor --json returns ok"
case "$(json 'd.data.checks.find(c=>c.name==="claude.auth").status' <<<"$doc")" in warn|fail) ok "doctor reports Claude auth as not ready";; *) fail "claude.auth should be warn/fail without login";; esac

step "init (shared)"
out="$("$M" init "$B" --yes --shared --json)"; PROJECT_IDS+=("$(json 'd.data.plan.projectId' <<<"$out")")
[ -f "$B/.minions/config.json" ] && ok "shared init wrote .minions/config.json" || fail ".minions/config.json missing"

step "channel show / set (shared config, never committed)"
cd "$B"
expect_eq "$("$M" channel show --json | json 'd.data.configured+" "+d.data.effective')" "auto terminal" "channel auto resolves to terminal without a bot token"
rev="$(json 'd.configRevision' < "$B/.minions/config.json")"
head_before="$(git -C "$B" rev-parse HEAD)"
set +e; "$M" channel set terminal --json </dev/null >/dev/null 2>&1; rc=$?; set -e
expect_eq "$rc" 11 "channel set without --yes and without a terminal is refused"
expect_eq "$("$M" channel set terminal --dry-run --json | json 'd.data.applied')" false "channel set --dry-run writes nothing"
expect_eq "$(json 'd.configRevision' < "$B/.minions/config.json")" "$rev" "dry run keeps configRevision"
steps="$("$M" channel set telegram --yes --json | json 'd.data.nextSteps.join("\n")')"
grep -q 'minions auth telegram' <<<"$steps" || fail "channel set telegram hints minions auth telegram"
grep -q 'Commit .minions/config.json' <<<"$steps" || fail "channel set reminds to commit the shared config"
expect_eq "$(json 'd.configRevision+" "+d.communication.channel' < "$B/.minions/config.json")" "$((rev + 1)) telegram" "channel set bumps configRevision"
expect_eq "$(git -C "$B" rev-parse HEAD)" "$head_before" "channel set does not commit"
"$M" channel set auto --yes --json >/dev/null
cd - >/dev/null

step "start --no-attach"
cd "$A"
expect_eq "$("$M" start --no-attach --json | json 'd.data.running')" true "container running"
COMPOSE="$MINIONS_HOME/projects/$ID_A/compose.yaml"
cx() { docker compose -f "$COMPOSE" exec -T app "$@"; }
expect_eq "$(cx claude --version | awk '{print $1}')" "2.1.292" "claude --version"
expect_eq "$(cx backlog --version)" "1.54.0" "backlog --version"
expect_eq "$(cx bun --version)" "1.4.3" "bun --version"
cx test ! -e /workspace/repo/.env || fail ".env was imported"; ok "ignored .env not imported"
cx claude plugin validate /opt/minions/plugin >/dev/null || fail "plugin validate"; ok "plugin validates"
expect_eq "$(cx minions coordinator --probe --json | json 'd.data.claudeVersion' | awk '{print $1}')" 2.1.292 "capability probe"
argv="$(cx minions coordinator --print-command --json | json 'd.data.claude.args.join("\n")')"
tmuxargv="$(cx minions coordinator --print-command --json | json 'd.data.tmux.args.join(" ")')"
grep -q -- '-- minions coordinator run$' <<<"$tmuxargv" || fail "tmux does not run the exec wrapper"
for want in --plugin-dir /opt/minions/plugin --append-system-prompt --permission-mode; do
  grep -qxF -- "$want" <<<"$argv" || fail "coordinator argv lacks $want"
done
grep -qx bypassPermissions <<<"$argv" && fail "coordinator argv uses bypassPermissions"
ok "coordinator argv"

step "backlog + engineer/tester/reviewer flow"
t1="$(cx minions backlog create --title "Add greeting" --ac "prints hello" --key k1 --status ready --json)"
T="$(json 'd.data.task.id' <<<"$t1")"
expect_eq "$(cx minions backlog create --title "Add greeting" --ac "prints hello" --key k1 --status ready --json | json 'd.data.task.id+" "+d.data.created')" "$T false" "create is idempotent by key"
expect_eq "$(cx minions backlog ready --json | json 'd.data.tasks.map(t=>t.id).join()')" "$T" "backlog ready"
brief="$(cx minions work claim "$T" --role engineer --json)"
for f in briefMarker leaseId branch worktree baseSha expectedHead acceptanceCriteria verificationCommands resultContract; do
  json "JSON.stringify(d.data).includes('\"$f\"')" <<<"$brief" | grep -q true || fail "brief lacks $f"
done
ok "engineer brief has all fields"
LEASE="$(json 'd.data.leaseId' <<<"$brief")"; BRANCH="$(json 'd.data.branch' <<<"$brief")"; WT="$(json 'd.data.worktree' <<<"$brief")"
set +e; cx minions work claim "$T" --role engineer --json >/dev/null; rc=$?; set -e
expect_eq "$rc" 4 "second claim fails CONFLICT (exit 4)"
deny="$(printf '{"tool_name":"Agent","tool_input":{"subagent_type":"minions:engineer","prompt":"go"}}' | cx minions hook pre-agent)"
expect_eq "$(json 'd.hookSpecificOutput.permissionDecision' <<<"$deny")" deny "pre-agent denies an unclaimed minions:engineer"
expect_eq "$(printf '{"tool_name":"Agent","tool_input":{"subagent_type":"minions:engineer","prompt":"go\\nminions-lease: %s"}}' "$LEASE" | cx minions hook pre-agent)" "" "pre-agent allows a leased engineer"
H="$(cx sh -c "cd '$WT' && echo 'console.log(\"hello\")' > hello.js && git add hello.js && git commit -qm 'Add greeting' && git rev-parse HEAD")"
result() { printf '{"status":"complete","summary":"done","branch":"%s","headSha":"%s","modifiedPaths":["hello.js"],"checks":[{"command":"npm test","outcome":"pass"}],"acceptanceEvidence":[{"criterion":"prints hello","evidence":"hello.js"}],"findings":[],"nextAction":"next"%s}' "$BRANCH" "$H" "${1:-}"; }
expect_eq "$(result | cx minions work record "$LEASE" --json | json 'd.data.to')" testing "engineer record → testing"
L2="$(cx minions work claim "$T" --role tester --json | json 'd.data.leaseId')"
expect_eq "$(result | cx minions work record "$L2" --json | json 'd.data.to')" reviewing "tester record → reviewing"
rv="$(cx minions work claim "$T" --role reviewer --json)"
L3="$(json 'd.data.leaseId' <<<"$rv")"
expect_eq "$(cx git -C "$(json 'd.data.worktree' <<<"$rv")" rev-parse HEAD)" "$H" "review worktree at branch head"
expect_eq "$(result ',"verdict":"approve"' | cx minions work record "$L3" --json | json 'd.data.to')" delivered "reviewer approve → delivered"

step "stop hook"
S='{"session_id":"e2e","hook_event_name":"Stop","stop_hook_active":false}'
expect_eq "$(cx minions hook stop <<<"$S")" "" "empty queue allows stop"
cx minions backlog create --title "Second" --ac x --key k2 --status ready --json >/dev/null
expect_eq "$(cx minions hook stop <<<"$S" | json 'd.decision')" block "ready task blocks stop"
allowed=no
for _ in 1 2 3 4 5; do [ -z "$(cx minions hook stop <<<"$S")" ] && { allowed=yes; break; }; done
expect_eq "$allowed" yes "repeated stop without progress is eventually allowed"

step "host-delegated status / pause / resume"
expect_eq "$("$M" pause --json | json 'd.data.paused.starts')" true "pause"
expect_eq "$("$M" status --json | json 'd.data.paused.starts')" true "status sees pause"
expect_eq "$("$M" status --json | json 'd.data.channel.configured+" "+d.data.channel.effective')" "auto terminal" "status shows configured vs effective channel"
expect_eq "$(cx minions hook stop <<<"$S")" "" "paused allows stop"
expect_eq "$("$M" resume --json | json 'd.data.paused.starts')" false "resume"

step "export"
heads_before="$(git -C "$A" for-each-ref refs/heads)"
"$M" export --json >/dev/null
expect_eq "$(git -C "$A" rev-parse "refs/remotes/minions/$BRANCH")" "$H" "host has refs/remotes/minions/$BRANCH"
expect_eq "$(git -C "$A" for-each-ref refs/heads)" "$heads_before" "host local branches untouched"
expect_eq "$(git -C "$A" status --porcelain)" "$before" "host working tree untouched"

step "down / start persists state"
"$M" down --json >/dev/null
"$M" start --no-attach --json >/dev/null
expect_eq "$(cx minions backlog show "$T" --json | json 'd.data.status')" delivered "backlog persisted"
expect_eq "$(cx git -C /workspace/repo rev-parse "refs/heads/$BRANCH")" "$H" "workspace persisted"
expect_eq "$(cx minions status --json | json 'd.data.queue.ready')" 1 "runtime DB persisted"

step "Claude authorization: helper mode with a fake key script (no real credentials)"
cd "$A"
mkdir -p "$WORK/bin"
KEY1="fake-e2e-key-$(date +%s)-one"; KEY2="fake-e2e-key-rotated-two"
printf '%s' "$KEY1" > "$WORK/key.txt"
printf '#!/bin/sh\necho "pretend proxy started"\ncat "%s"\n' "$WORK/key.txt" > "$WORK/bin/fake-key"; chmod +x "$WORK/bin/fake-key"
# Fake Anthropic endpoint on host loopback: records the x-api-key header, answers 401 (no tokens anywhere).
cat > "$WORK/fake-api.mjs" <<'JS'
import http from 'node:http'; import fs from 'node:fs';
const [log, portFile] = process.argv.slice(2);
const s = http.createServer((q, r) => { fs.appendFileSync(log, `${q.method} ${q.url} ${q.headers['x-api-key'] ?? '-'}\n`); r.writeHead(401, { 'content-type': 'application/json' }); r.end('{"type":"error","error":{"type":"authentication_error","message":"fake"}}'); });
s.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(s.address().port)));
JS
: > "$WORK/fake-api.log"
node "$WORK/fake-api.mjs" "$WORK/fake-api.log" "$WORK/fake-api.port" & SERVER_PID=$!; disown "$SERVER_PID"
for _ in $(seq 50); do [ -s "$WORK/fake-api.port" ] && break; sleep 0.1; done
PORT="$(cat "$WORK/fake-api.port")"
set_out="$("$M" auth set helper --yes --json --refresh-minutes 5 --env "ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT/fake/anthropic" -- "$WORK/bin/fake-key")"
expect_eq "$(json 'd.data.provisioned!==null' <<<"$set_out")" true "auth set helper provisions the key"
SECRET="$MINIONS_HOME/projects/$ID_A/secrets/anthropic-api-key"
expect_eq "$(stat -f '%Lp' "$SECRET")" 600 "host key file is 0600"
for f in "$COMPOSE" "$MINIONS_HOME/projects/$ID_A/project.json"; do grep -qF "$KEY1" "$f" && fail "key leaked into $f"; done
grep -qF "$KEY1" <<<"$set_out$("$M" auth show --json)$("$M" auth show)" && fail "key leaked into auth output"
ok "key absent from compose.yaml, project.json and auth output"
grep -q 'target: "/opt/minions/secrets"' "$COMPOSE" && ! grep -q 'anthropic-api-key' "$COMPOSE" || fail "compose must mount the secrets directory"
ok "compose mounts the secrets directory"
start_out="$("$M" start --no-attach --json 2>&1)"
grep -qF "$KEY1" <<<"$start_out" && fail "key leaked into start output"
expect_eq "$(cx printenv MINIONS_AUTH_METHOD)" helper "container recreated with the helper method"
expect_eq "$(cx printenv ANTHROPIC_BASE_URL)" "http://host.docker.internal:$PORT/fake/anthropic" "loopback base URL rewritten"
cx test -r /opt/minions/secrets/anthropic-api-key || fail "key not readable in container"; ok "key readable in container"
expect_eq "$(cx cat /opt/minions/secrets/anthropic-api-key)" "$KEY1" "container sees the provisioned key"
cx sh -c 'echo x > /opt/minions/secrets/anthropic-api-key' 2>/dev/null && fail "key file is writable in container"
cx sh -c 'touch /opt/minions/secrets/new' 2>/dev/null && fail "secrets dir is writable in container"
ok "secrets mount is read-only"
expect_eq "$(cx minions coordinator --print-command --json | json 'JSON.parse(d.data.claude.args[d.data.claude.args.indexOf("--settings")+1]).apiKeyHelper')" "cat /opt/minions/secrets/anthropic-api-key" "coordinator settings carry apiKeyHelper"
printf '%s' "$KEY2" > "$WORK/key.txt"
"$M" auth refresh --json >/dev/null
expect_eq "$(cx cat /opt/minions/secrets/anthropic-api-key)" "$KEY2" "refreshed key visible through the directory mount (no restart)"
doc="$("$M" doctor --json)"
expect_eq "$(json 'd.data.checks.find(c=>c.name==="claude.auth").status' <<<"$doc")" ok "doctor: key readable in container"
expect_eq "$(json 'd.data.checks.find(c=>c.name==="claude.baseUrl").status' <<<"$doc")" ok "doctor: base URL reachable from container"
grep -qF "$KEY2" <<<"$doc" && fail "key leaked into doctor output"
cx timeout 60 claude -p hello --settings '{"apiKeyHelper":"cat /opt/minions/secrets/anthropic-api-key"}' </dev/null >/dev/null 2>&1 || true
grep -q "POST /fake/anthropic/v1/messages.* $KEY2\$" "$WORK/fake-api.log" || fail "Claude Code did not send the helper key to the configured base URL"
ok "Claude Code in the container sends the helper key to ANTHROPIC_BASE_URL"
"$M" auth set login --yes --json >/dev/null
"$M" start --no-attach --json >/dev/null
expect_eq "$(cx printenv MINIONS_AUTH_METHOD)" login "back to login: container recreated"
cx test ! -e /opt/minions/secrets/anthropic-api-key || fail "Claude key still present for login"
cx minions coordinator --print-command --json | grep -q apiKeyHelper && fail "login settings must not set apiKeyHelper"
ok "login method: no Claude key in the secrets mount, no apiKeyHelper"
[ ! -e "$SECRET" ] && ok "host key file removed for login" || fail "host key file still present"

step "uninstall"
cd "$B"
expect_eq "$("$M" uninstall --yes --json | json 'd.data.volumesKept.length')" 4 "shared uninstall keeps volumes"
[ ! -e "$B/.minions" ] && ok "shared uninstall removed .minions/" || fail ".minions/ still present"
cd "$A"
expect_eq "$("$M" uninstall --yes --delete-data --json | json 'd.data.volumesKept.length')" 0 "uninstall --delete-data"
[ -z "$(docker volume ls -q --filter "name=minions-${ID_A:0:8}-")" ] && ok "volumes deleted" || fail "volumes remain"
expect_eq "$(git -C "$A" status --porcelain)" "$before" "private uninstall leaves the repo unchanged"
