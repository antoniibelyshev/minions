#!/usr/bin/env bash
# Opt-in end-to-end test of the HOST runtime (no Docker; no Claude login, no API calls).
#   npm run e2e:host
# Builds and packs the package, installs it into a temp npm prefix, and drives `minions` against a
# disposable Git repo with a temp MINIONS_HOME. PATH is restricted to node, git, the real Backlog.md
# CLI (installed into the temp dir) and fakes for tmux and claude, so Docker is never reachable and no
# real Claude Code session starts. Everything it creates lives in one temp dir removed on exit.
# Set E2E_KEEP=1 to keep the temp dir for debugging.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/minions-e2e-host.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
# A space in the data root exercises quoting in shims, apiKeyHelper and the git credential helper.
export MINIONS_HOME="$WORK/home dir"
PREFIX="$WORK/prefix"
TOOLS="$WORK/tools"
M="$PREFIX/node_modules/.bin/minions"

step() { printf '\n==> %s\n' "$*" >&2; }
ok() { printf '  ok: %s\n' "$*" >&2; }
fail() { printf '  FAIL: %s\n' "$*" >&2; exit 1; }
json() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const v=(0,eval)("(d)=>("+process.argv[1]+")")(d);process.stdout.write(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }
expect_eq() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; ok "$3"; }

cleanup() {
  local code=$?
  if [ "${E2E_KEEP:-}" = 1 ]; then printf '\nKept %s (MINIONS_HOME=%s)\n' "$WORK" "$MINIONS_HOME" >&2; exit "$code"; fi
  rm -rf "$WORK"
  [ "$code" = 0 ] && printf '\nHOST E2E PASSED\n' >&2 || printf '\nHOST E2E FAILED (exit %s)\n' "$code" >&2
  exit "$code"
}
trap cleanup EXIT

step "Build, pack, install into a temp prefix; Backlog.md CLI into a temp tools prefix"
(cd "$ROOT" && npm run --silent build && npm pack --silent --pack-destination "$WORK" >/dev/null)
npm install --silent --no-fund --no-audit --prefix "$PREFIX" "$WORK"/minions-*.tgz
npm install --silent --no-fund --no-audit --prefix "$TOOLS" backlog.md@1.54.0
ok "minions $("$M" --version), backlog $("$TOOLS/node_modules/.bin/backlog" --version)"

step "Restricted PATH: node, git, backlog, fake tmux and claude (no docker, no gh, no real claude)"
mkdir -p "$WORK/bin" "$WORK/fake"
ln -s "$(command -v node)" "$WORK/bin/node"
ln -s "$(command -v git)" "$WORK/bin/git"
ln -s "$TOOLS/node_modules/.bin/backlog" "$WORK/bin/backlog"
# Fake tmux: -V, has-session/new-session/kill-server per -L socket; `new-session -d` runs the command
# in the background (the real coordinator exec wrapper, which then starts the fake claude).
cat > "$WORK/bin/tmux" <<SH
#!/bin/sh
echo "tmux \$*" >> "$WORK/fake/tmux.log"
sock=default
[ "\$1" = "-L" ] && { sock="\$2"; shift 2; }
[ "\$1" = "-u" ] && shift
case "\$1" in
  -V) echo "tmux 3.5a" ;;
  has-session) [ -e "$WORK/fake/session-\$sock" ] ;;
  kill-server|kill-session) rm -f "$WORK/fake/session-\$sock" ;;
  new-session)
    detached=no
    while [ \$# -gt 0 ] && [ "\$1" != "--" ]; do [ "\$1" = "-d" ] && detached=yes; shift; done
    shift
    touch "$WORK/fake/session-\$sock"
    if [ "\$detached" = yes ]; then "\$@" >> "$WORK/fake/session.log" 2>&1 & else "\$@"; fi ;;
  *) exit 1 ;;
esac
SH
# Fake claude: version/help/auth; any other invocation records argv and selected env, then exits.
cat > "$WORK/bin/claude" <<SH
#!/bin/sh
case "\$1" in
  --version) echo "2.1.292 (Claude Code)"; exit 0 ;;
  --help) echo "--plugin-dir --append-system-prompt --permission-mode --settings --setting-sources --strict-mcp-config --add-dir"; exit 0 ;;
  auth) exit 0 ;;
esac
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), env: { MINIONS_RUNTIME: process.env.MINIONS_RUNTIME, PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN ?? null } }))' "$WORK/fake/claude.json" "\$@"
SH
chmod +x "$WORK/bin/tmux" "$WORK/bin/claude"
export PATH="$WORK/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GH_TOKEN="ghp_userTokenThatMustNotReachAgents000000"
command -v docker >/dev/null && fail "docker must not be on PATH for this test"
ok "PATH has no docker"

A="$WORK/repo"
mkdir -p "$A" && cd "$A"
git init -q -b main
git config user.name "E2E User" && git config user.email e2e@example.com && git config commit.gpgsign false
printf '{"name":"demo","version":"1.0.0","scripts":{"test":"node -e \\"console.log(1)\\""}}\n' > package.json
printf '.env\n' > .gitignore
printf 'FAKE_SECRET=do-not-import\n' > .env
printf '# demo\n' > README.md
git add -A && git commit -qm init
before="$(git status --porcelain)"

step "init --runtime host (no Docker)"
init_err="$WORK/init.err"
out="$("$M" init "$A" --yes --private --runtime host --json 2>"$init_err")"
ID="$(json 'd.data.plan.projectId' <<<"$out")"
expect_eq "$(json 'd.data.plan.runtime' <<<"$out")" host "plan records the host runtime"
json 'd.data.plan.warnings.join(" ")' <<<"$out" | grep -q 'agents run as your macOS user' || fail "init warning missing"
ok "init warns"
P="$MINIONS_HOME/projects/$ID"
expect_eq "$(json 'd.runtime' < "$P/project.json")" host "project.json runtime host"
expect_eq "$(git status --porcelain)" "$before" "private init leaves git status unchanged"

step "doctor (host mode)"
doc="$("$M" doctor --json || true)"  # doctor exits 1 on blocking FAIL; the checks are asserted below
expect_eq "$(json 'd.data.checks.find(c=>c.name==="runtime").status' <<<"$doc")" warn "doctor: runtime is a warn-level check"
for t in tmux claude backlog git; do expect_eq "$(json "d.data.checks.find(c=>c.name===\"host.$t\").status" <<<"$doc")" ok "doctor: host.$t"; done
expect_eq "$(json 'd.data.checks.some(c=>c.name.startsWith("docker."))' <<<"$doc")" false "doctor does not check Docker"
expect_eq "$(json 'd.data.checks.find(c=>c.name==="setup").status' <<<"$doc")" ok "doctor: setup check (verification commands inferred)"

step "start --no-attach: warning, separate workspace clone, state"
start_err="$WORK/start.err"
st="$("$M" start --no-attach --json 2>"$start_err")"
expect_eq "$(json 'd.data.runtime' <<<"$st")" host "start uses the host runtime"
grep -q 'WARNING: host runtime' "$start_err" || fail "start must print the warning"
ok "start prints the warning"
W="$P/host/workspace/repo"
SHIM="$P/host/bin/minions"
expect_eq "$(git -C "$W" rev-parse HEAD)" "$(git rev-parse HEAD)" "workspace clone at the base commit"
[ ! -e "$W/.env" ] && ok "ignored .env not imported" || fail ".env was imported"
expect_eq "$(stat -f '%Lp' "$P/host")" 700 "host runtime dir is 0700"
[ -f "$P/host/state/minions.db" ] && ok "runtime DB in host state" || fail "no runtime DB"
expect_eq "$(git status --porcelain)" "$before" "user checkout untouched"

step "runtime commands through the shim (no container)"
argv="$("$SHIM" coordinator --print-command --json)"
expect_eq "$(json 'd.data.tmux.args.slice(0,2).join(" ")' <<<"$argv")" "-L minions-${ID:0:8}" "dedicated tmux server"
settings="$(json 'd.data.claude.args[d.data.claude.args.indexOf("--settings")+1]' <<<"$argv")"
expect_eq "$(json 'd.sandbox.enabled' <<<"$settings")" true "coordinator settings enable the sandbox"
expect_eq "$(json 'd.permissions.deny.includes("Read(~/.ssh/**)")' <<<"$settings")" true "settings deny ~/.ssh"
expect_eq "$(json 'd.permissions.disableBypassPermissionsMode' <<<"$settings")" disable "bypass disabled"
json 'd.data.claude.args' <<<"$argv" | grep -q bypassPermissions && fail "argv uses bypassPermissions"
expect_eq "$(json 'd.data.claude.args.includes("--setting-sources=") && d.data.claude.args.includes("--strict-mcp-config")' <<<"$argv")" true "no user/project settings or MCP servers"
expect_eq "$(json 'd.sandbox.filesystem.allowWrite.some(p=>p.startsWith("~"))' <<<"$settings")" false "no home paths writable"
expect_eq "$(json 'd.sandbox.filesystem.denyRead.includes(process.env.MINIONS_HOME)' <<<"$settings")" true "data root unreadable to sandboxed commands"
expect_eq "$(json 'd.sandbox.network.allowUnixSockets.length' <<<"$settings")" 0 "no Unix sockets"
expect_eq "$(json 'd.permissions.allow.includes("Bash(git *)")' <<<"$settings")" false "no blanket git allow"
set +e; "$SHIM" telegram install --json >/dev/null 2>&1; rc=$?; set -e
expect_eq "$rc" 11 "telegram install refused in the host runtime"
t1="$("$SHIM" backlog create --title "Add greeting" --ac "prints hello" --key k1 --status ready --json)"
T="$(json 'd.data.task.id' <<<"$t1")"
brief="$("$SHIM" work claim "$T" --role engineer --json)"
LEASE="$(json 'd.data.leaseId' <<<"$brief")"; BRANCH="$(json 'd.data.branch' <<<"$brief")"; WT="$(json 'd.data.worktree' <<<"$brief")"
case "$WT" in "$P/host/workspace/worktrees/"*) ok "worktree under the host workspace";; *) fail "worktree at $WT";; esac
deny="$(printf '{"tool_name":"Agent","tool_input":{"subagent_type":"minions:engineer","prompt":"go"}}' | "$SHIM" hook pre-agent)"
[ -s "$P/host/logs/hooks.log" ] && ok "hooks log outside the agent-writable state" || fail "hooks.log not in host/logs"
expect_eq "$(json 'd.hookSpecificOutput.permissionDecision' <<<"$deny")" deny "pre-agent hook denies an unclaimed worker"
H="$(cd "$WT" && echo 'console.log("hello")' > hello.js && git add hello.js && git -c commit.gpgsign=false commit -qm 'Add greeting' && git rev-parse HEAD)"
result() { printf '{"status":"complete","summary":"done","branch":"%s","headSha":"%s","modifiedPaths":["hello.js"],"checks":[{"command":"npm test","outcome":"pass"}],"acceptanceEvidence":[{"criterion":"prints hello","evidence":"hello.js"}],"findings":[],"nextAction":"next"%s}' "$BRANCH" "$H" "${1:-}"; }
# No QA label: the default workflow skips the tester stage.
expect_eq "$(result | "$SHIM" work record "$LEASE" --json | json 'd.data.to')" reviewing "engineer -> reviewing"
L3="$("$SHIM" work claim "$T" --role reviewer --json | json 'd.data.leaseId')"
expect_eq "$(result ',"verdict":"approve"' | "$SHIM" work record "$L3" --json | json 'd.data.to')" delivered "reviewer approve -> delivered"

step "host CLI runs status / pause / resume directly (no docker exec)"
expect_eq "$("$M" pause --json | json 'd.data.paused.starts')" true "pause"
expect_eq "$("$M" status --json | json 'd.data.paused.starts')" true "status"
expect_eq "$("$M" status --json | json 'd.data.channel.configured+" "+d.data.channel.effective')" "auto terminal" "status: channel auto is terminal in the host runtime"
expect_eq "$("$M" channel show --json | json 'd.data.cause')" "no-token" "channel show in the host runtime"
expect_eq "$("$M" resume --json | json 'd.data.paused.starts')" false "resume"

step "coordinator launch (fake tmux + fake claude) and down"
"$SHIM" coordinator sync --start-detached --json >/dev/null
for _ in $(seq 50); do [ -s "$WORK/fake/claude.json" ] && break; sleep 0.1; done
[ -s "$WORK/fake/claude.json" ] || { cat "$WORK/fake/session.log" >&2 || true; fail "coordinator did not launch claude"; }
expect_eq "$(json 'd.env.MINIONS_RUNTIME' < "$WORK/fake/claude.json")" host "claude runs with MINIONS_RUNTIME=host"
expect_eq "$(json 'd.env.GH_TOKEN' < "$WORK/fake/claude.json")" null "the user's GH_TOKEN does not reach the coordinator"
expect_eq "$(json 'JSON.parse(d.argv[d.argv.indexOf("--settings")+1]).sandbox.enabled' < "$WORK/fake/claude.json")" true "launched with the sandbox"
expect_eq "$("$M" down --json | json 'd.data.wasRunning')" true "down stops the tmux server"
grep -q "tmux -L minions-${ID:0:8} kill-server" "$WORK/fake/tmux.log" || fail "down did not kill the dedicated server"
grep -v -- ' -L ' "$WORK/fake/tmux.log" | grep -Eq 'session|server' && fail "a tmux call used the default server"
ok "only the dedicated tmux server was used"

step "upgrade on the host runtime (task-7): dry run, drain, shim regeneration, coordinator restart, refusals"
ntmux() { grep -c "new-session" "$WORK/fake/tmux.log" || true; }
"$SHIM" coordinator sync --start-detached --json >/dev/null
shim_before="$(cat "$SHIM")"
dry="$("$M" upgrade --dry-run --json)"
expect_eq "$(json 'd.data.steps.some(s=>["image","recreate","origin"].includes(s.id))' <<<"$dry")" false "upgrade dry run: no image, recreate or origin step"
expect_eq "$(json '["preflight","pause","drain","files","secrets","shim","workspace","resume","coordinator"].every(id=>d.data.steps.some(s=>s.id===id&&s.detail))' <<<"$dry")" true "upgrade dry run explains every host step"
expect_eq "$(cat "$SHIM")" "$shim_before" "upgrade dry run leaves the shim"
T2="$("$SHIM" backlog create --title "Upgrade drain" --ac "x" --key k-upgrade --status ready --json | json 'd.data.task.id')"
UL="$("$SHIM" work claim "$T2" --role engineer --json | json 'd.data.leaseId')"
nl="$("$M" status --json | json 'd.data.activeLeases.length')"
n0="$(ntmux)"
set +e; "$M" upgrade --timeout 1 --json >/dev/null 2>&1; rc=$?; set -e
expect_eq "$rc" 11 "upgrade with an active lease aborts at the drain timeout"
expect_eq "$(ntmux)" "$n0" "aborted upgrade did not restart the coordinator"
expect_eq "$("$M" status --json | json 'd.data.paused.starts+" "+d.data.activeLeases.length')" "false $nl" "aborted upgrade resumed starts and kept the lease"
expect_eq "$(cat "$SHIM")" "$shim_before" "aborted upgrade left the shim"
# A new CLI install (a copy of the prefix): the upgrade run by it points the shim at it.
cp -R "$PREFIX" "$WORK/prefix2"
M2="$WORK/prefix2/node_modules/minions/dist/cli.js"
up="$(node "$M2" upgrade --now --json 2>/dev/null)"
expect_eq "$(json "d.data.ok && d.data.interrupted.some(l=>l.id==='$UL')" <<<"$up")" true "upgrade --now released the lease, then finished"
expect_eq "$(json 'd.data.steps.find(s=>s.id==="coordinator").status' <<<"$up")" done "coordinator restarted after the release"
[ "$(ntmux)" -gt "$n0" ] && ok "coordinator relaunched" || fail "coordinator not relaunched"
grep -qF "$M2" "$SHIM" && ok "shim points at the CLI that ran the upgrade" || fail "shim not regenerated"
# (host commands such as status rewrite the shim for the CLI that runs them, so this check comes first)
expect_eq "$("$M" status --json | json 'd.data.activeLeases.length')" 0 "no worker lease left after the upgrade"
# A CLI inside (or linked into) the agent-writable workspace is refused before anything changes.
EVIL="$P/host/workspace/evil"
cp -R "$PREFIX" "$EVIL" && ln -s "$EVIL" "$WORK/linked-cli"
shim_now="$(cat "$SHIM")"
set +e; e1="$(node "$EVIL/node_modules/minions/dist/cli.js" upgrade --dry-run --json 2>/dev/null)"; set -e
expect_eq "$(json 'd.data.steps.find(s=>s.id==="preflight").status' <<<"$e1")" failed "dry run from a workspace CLI fails the preflight"
set +e; node "$WORK/linked-cli/node_modules/minions/dist/cli.js" upgrade --now --json >/dev/null 2>&1; rc=$?; set -e
expect_eq "$rc" 11 "upgrade through a link into the workspace is refused"
expect_eq "$(cat "$SHIM")" "$shim_now" "refused upgrade left the shim"
rm -rf "$EVIL" "$WORK/linked-cli"
# The runtime records an upgrade request; the owner applies it: export, fast-forward, upgrade, marked applied.
WH="$(cd "$W" && git -c user.name=a -c user.email=a@b -c commit.gpgsign=false commit -q --allow-empty -m "merged in the runtime" && git rev-parse HEAD)"
RID="$("$SHIM" upgrade --from-container --reason "self-update" --json | json 'd.data.request.id')"
"$M" export --json >/dev/null
"$M" upgrade --from-container --json >/dev/null 2>&1
expect_eq "$(git -C "$A" rev-parse main)" "$WH" "upgrade --from-container fast-forwarded main from the host workspace"
"$SHIM" settings requests mark "$RID" --status applied --json >/dev/null
expect_eq "$("$SHIM" settings requests --all --json | json "d.data.requests.find(r=>r.id==='$RID').status")" applied "upgrade request marked applied"
"$M" down --json >/dev/null

step "export into refs/remotes/minions/*"
heads_before="$(git for-each-ref refs/heads)"
"$M" export --json >/dev/null
expect_eq "$(git rev-parse "refs/remotes/minions/$BRANCH")" "$H" "host repo has refs/remotes/minions/$BRANCH"
expect_eq "$(git for-each-ref refs/heads)" "$heads_before" "local branches untouched"

step "Claude key helper in host mode (fake key script; apiKeyHelper reads the 0600 file)"
printf '#!/bin/sh\necho fake-e2e-host-key-0001\n' > "$WORK/bin/fake-key"; chmod +x "$WORK/bin/fake-key"
"$M" auth set helper --yes --json -- "$WORK/bin/fake-key" >/dev/null
"$M" start --no-attach --json >/dev/null 2>&1
expect_eq "$(stat -f '%Lp' "$P/secrets/anthropic-api-key")" 600 "key file 0600"
helper="$("$SHIM" coordinator --print-command --json | json 'JSON.parse(d.data.claude.args[d.data.claude.args.indexOf("--settings")+1]).apiKeyHelper')"
expect_eq "$helper" "cat '$P/secrets/anthropic-api-key'" "apiKeyHelper quotes the host path"
expect_eq "$(sh -c "$helper")" fake-e2e-host-key-0001 "apiKeyHelper prints the key"
"$M" auth set login --yes --json >/dev/null

step "runtime show/set and uninstall"
expect_eq "$("$M" runtime show --json | json 'd.data.runtime')" host "runtime show"
expect_eq "$("$M" runtime set docker --json | json 'd.data.to')" docker "runtime set docker"
set +e; "$M" runtime set host --json </dev/null >/dev/null 2>&1; rc=$?; set -e
expect_eq "$rc" 11 "runtime set host without confirmation fails (PRECONDITION)"
"$M" runtime set host --yes --json >/dev/null 2>"$WORK/set.err"
grep -q 'WARNING: host runtime' "$WORK/set.err" || fail "runtime set host must print the warning"
ok "runtime set host --yes prints the warning"
expect_eq "$("$M" uninstall --yes --delete-data --json | json 'd.data.hostData.deleted')" true "uninstall --delete-data removes the host workspace"
[ ! -e "$P/host" ] && ok "host dir gone" || fail "host dir remains"
expect_eq "$(git status --porcelain)" "$before" "repo unchanged"
