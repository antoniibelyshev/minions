// task-14.3 QA: adversarial escape attempts against the real minions-sandbox helper, under the rules
// buildSandboxRules generates for an engineer (producer) and a reviewer (gate). Runs only when a built
// helper with Landlock ABI >= 6 and /usr/bin/perl are available (MINIONS_SANDBOX_TEST_BIN, or the image
// path), on x86_64 or aarch64. Every attempt is a Perl script inside the sandbox; the outside view
// (listener logs, the outside process's signals, nice value and affinity, fixture metadata) is checked too.
//
// The TCP Fast Open, metadata-write (chmod/utime/setxattr) and outside-scheduling escapes found in the
// first QA pass are now closed by the seccomp filter and its chmod user-notification handler; the matching
// tests assert they stay closed. A separate test proves git still works (path chmod inside the worktree).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../src/core/exec.js';
import { SANDBOX_BIN, buildSandboxRules, sandboxArgv, serializeRules, type SandboxRoleView } from '../../src/runtime/sandbox/rules.js';

function realHelper(): string | null {
  const bin = process.env.MINIONS_SANDBOX_TEST_BIN || SANDBOX_BIN;
  try {
    accessSync(bin, constants.X_OK);
    return Number(execFileSync(bin, ['--abi'], { encoding: 'utf8' }).trim()) >= 6 ? bin : null;
  } catch { return null; }
}

/** Syscall numbers the script needs that Perl has no builtin for. */
const NR: Record<string, Record<string, number>> = {
  arm64: { ptrace: 117, pidfd_open: 434, pidfd_send_signal: 424, pidfd_getfd: 438, tgkill: 131, sched_setaffinity: 122, ioprio_set: 30, io_uring_setup: 425, setxattr: 5, unshare: 97 },
  x64: { ptrace: 101, pidfd_open: 434, pidfd_send_signal: 424, pidfd_getfd: 438, tgkill: 234, sched_setaffinity: 203, ioprio_set: 251, io_uring_setup: 425, setxattr: 188, unshare: 272 },
};
const REAL = realHelper();
const SYS = NR[process.arch];
const PERL = existsSync('/usr/bin/perl') ? '/usr/bin/perl' : null;

/** Prints `name \t ok|denied \t detail` per attempt; `ok` means the operation succeeded. */
const ATTACK = String.raw`
use strict; use warnings; use Socket qw(:all); use POSIX (); use JSON::PP;
$| = 1;
my $c = decode_json(do { local $/; open(my $f, '<', $ARGV[0]) or die "plan: $!"; <$f> });
my %nr = %{$c->{nr}};
sub r { my ($n, $ok, $d) = @_; print join("\t", $n, $ok ? 'ok' : 'denied', $d // ''), "\n"; }
sub sc { my $n = shift; syscall($nr{$n}, @_) }
for my $p (@{$c->{read}}) {
  if (-d $p) { my $ok = opendir(my $d, $p); r("read:$p", $ok, "$!"); }
  else { my $ok = open(my $f, '<', $p); r("read:$p", $ok, "$!"); }
}
for my $d (@{$c->{write}}) {
  my $ok = sysopen(my $f, "$d/.escape-$$", POSIX::O_WRONLY|POSIX::O_CREAT|POSIX::O_EXCL, 0600);
  if ($ok) { close $f; unlink "$d/.escape-$$"; }
  r("create:$d", $ok, "$!");
  $ok = mkdir("$d/.escdir-$$"); rmdir "$d/.escdir-$$" if $ok;
  r("mkdir:$d", $ok, "$!");
}
my $file = $c->{protectedFile};
{ my $ok = open(my $h, '>>', $file); r('append:protected', $ok, "$!"); }
r('truncate:protected', truncate($file, 0), "$!");
r('unlink:protected', unlink($file), "$!");
r('rename:protected', rename($file, "$file.moved"), "$!");
r('hardlink:protected->scratch', link($file, "$c->{scratch}/hl-$$"), "$!");
r('rename:protected->scratch', rename($file, "$c->{scratch}/mv-$$"), "$!");
symlink($file, "$c->{scratch}/sym-$$");
{ my $ok = open(my $h, '<', "$c->{scratch}/sym-$$"); r('read:via-symlink', $ok, "$!"); }
{ my $ok = open(my $h, '<', "/proc/self/root$file"); r('read:via-proc-self-root', $ok, "$!"); }
r('chmod:protected', chmod(0640, $file), "$!");
{ my $sym = "$c->{scratch}/chsym-$$"; symlink($file, $sym);
  r('chmod:via-symlink', chmod(0777, $sym), "$!"); unlink $sym; }
r('chmod:via-proc-self-root', chmod(0777, "/proc/self/root$file"), "$!");
{ my $w = "$c->{scratch}/chmod-ok-$$"; my $h; open($h, '>', $w) and close($h);
  r('chmod:scratch-allowed', chmod(0750, $w), "$!"); unlink $w; }
r('utime:protected', utime(1, 1, $file), "$!");
{ my ($n, $v) = ('user.minions-escape', 'x'); r('setxattr:protected', sc('setxattr', $file, $n, $v, 1, 0) == 0, "$!"); }

my $p = $c->{outsidePid} + 0;
r('kill0:outside', kill(0, $p), "$!");
r('kill-usr1:outside', kill('USR1', $p), "$!");
r('tgkill0:outside', sc('tgkill', $p, $p, 0) == 0, "$!");
{ my $ok = open(my $h, '<', "/proc/$p/environ"); r('read:/proc/outside/environ', $ok, "$!"); }
{ my $ok = open(my $h, '<', "/proc/$p/mem"); r('read:/proc/outside/mem', $ok, "$!"); }
{ my $l = readlink("/proc/$p/cwd"); r('readlink:/proc/outside/cwd', defined $l, "$!"); }
{ my $ok = sc('ptrace', 0x4206, $p, 0, 0) == 0; r('ptrace-seize:outside', $ok, "$!"); sc('ptrace', 17, $p, 0, 0) if $ok; }
{ my $fd = sc('pidfd_open', $p, 0);
  r('pidfd_send_signal:outside', $fd >= 0 && sc('pidfd_send_signal', $fd, 10, 0, 0) == 0, "$!");
  r('pidfd_getfd:outside', $fd >= 0 && sc('pidfd_getfd', $fd, 0, 0) >= 0, "$!"); }
{ socketpair(my $a, my $b, AF_UNIX, SOCK_STREAM, 0) or die "socketpair: $!";
  fcntl($a, 8, $p); my $fl = fcntl($a, 3, 0); fcntl($a, 4, $fl | ($c->{oAsync} + 0)); syswrite($b, 'x');
  select(undef, undef, undef, 0.2); }
r('setpriority:outside', setpriority(0, $p, 7), "$!");
{ my $mask = pack('Q', 1); r('sched_setaffinity:outside', sc('sched_setaffinity', $p, 8, $mask) == 0, "$!"); }
r('ioprio_set:outside', sc('ioprio_set', 1, $p, 3 << 13) == 0, "$!");

r('socket:AF_UNIX', socket(my $u, AF_UNIX, SOCK_STREAM, 0), "$!");
r('socket:AF_UNIX-dgram', socket(my $ud, AF_UNIX, SOCK_DGRAM, 0), "$!");
r('socket:AF_PACKET', socket(my $pk, 17, SOCK_RAW, 0), "$!");
r('socket:raw-icmp', socket(my $ri, AF_INET, SOCK_RAW, 1), "$!");
r('socket:raw-ipv6', socket(my $r6, AF_INET6, SOCK_RAW, 58), "$!");
r('socket:AF_ALG', socket(my $alg, 38, 5, 0), "$!");
r('socket:AF_VSOCK', socket(my $vs, 40, SOCK_STREAM, 0), "$!");
{ my $b = "\0" x 256; r('io_uring_setup', sc('io_uring_setup', 4, $b) >= 0, "$!"); }
r('unshare:user', sc('unshare', 0x10000000) == 0, "$!");

my $port = $c->{port} + 0;
for my $a (['127.0.0.1', AF_INET], ['::1', AF_INET6], ['::ffff:127.0.0.1', AF_INET6]) {
  socket(my $s, $a->[1], SOCK_STREAM, 0) or do { r("tcp-connect:$a->[0]", 0, "socket: $!"); next };
  my $sa = $a->[1] == AF_INET ? pack_sockaddr_in($port, inet_aton($a->[0])) : pack_sockaddr_in6($port, inet_pton(AF_INET6, $a->[0]));
  r("tcp-connect:$a->[0]", connect($s, $sa), "$!");
}
{ socket(my $t, AF_INET, SOCK_STREAM, 0);
  my $n = send($t, "fastopen\n", MSG_FASTOPEN, pack_sockaddr_in($port, inet_aton('127.0.0.1')));
  r('tcp-fastopen:127.0.0.1', defined $n, "$!"); select(undef, undef, undef, 0.3); }
{ socket(my $fc, AF_INET, SOCK_STREAM, 0);
  my $ok = setsockopt($fc, IPPROTO_TCP, 30, pack('l', 1)); # TCP_FASTOPEN_CONNECT = 30
  r('tcp-fastopen-connect:setsockopt', defined $ok, "$!");
  r('tcp-fastopen-connect:connect', connect($fc, pack_sockaddr_in($port, inet_aton('127.0.0.1'))), "$!");
  select(undef, undef, undef, 0.3); }
print "end\n";
`;

interface Outside { pid: number; signals: string[]; proc: ChildProcess }

describe.skipIf(!REAL || !SYS || !PERL)('minions-sandbox escape attempts (real helper, engineer and gate rules)', () => {
  const bin = REAL!;
  let root: string;
  let server: Server;
  let port = 0;
  const tcpSeen: string[] = [];
  let outside: Outside;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sbx-escape-'));
    server = createServer((s) => { tcpSeen.push('connection'); s.on('data', (d) => tcpSeen.push(String(d))); s.end(); });
    await new Promise<void>((r) => server.listen(0, '::', () => r()));
    port = (server.address() as { port: number }).port;
    // An unrelated process outside the sandbox (stands in for the coordinator/runner): logs every signal.
    const proc = spawn(PERL!, ['-e', '$|=1; for my $s (qw(IO USR1 USR2 URG)) { $SIG{$s} = sub { print "SIG$_[0]\\n" } } print "ready\\n"; sleep 1 while 1;'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const signals: string[] = [];
    await new Promise<void>((r) => proc.stdout!.on('data', (d: Buffer) => { for (const l of String(d).split('\n').filter(Boolean)) { if (l === 'ready') r(); else signals.push(l); } }));
    outside = { pid: proc.pid!, signals, proc };
  });
  afterAll(async () => {
    outside?.proc.kill('SIGKILL');
    await new Promise<void>((r) => server ? server.close(() => r()) : r());
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function attack(role: SandboxRoleView) {
    const base = join(root, role.name);
    const d = (...p: string[]) => join(base, ...p);
    for (const dir of [d('scratch'), d('common', 'objects'), d('common', 'refs', 'heads'), d('state'), d('secrets'), d('worktrees', 'other'), d('lease'), d('other-lease', 'scratch')]) await mkdir(dir, { recursive: true });
    await writeFile(d('common', 'config'), '[core]\n');
    await writeFile(d('state', 'minions.db'), 'db');
    await writeFile(d('secrets', 'github-token'), 'not-a-real-token');
    await chmod(d('secrets', 'github-token'), 0o600);
    await writeFile(d('worktrees', 'other', 'README'), 'x');
    const rules = buildSandboxRules({
      role, leaseId: 'lease-escape',
      layout: { scratchDir: d('scratch'), gitObjectsDir: d('common', 'objects'), harnessDir: null },
      protectedPaths: [d('state'), d('secrets'), d('common'), d('worktrees'), d('lease')],
    });
    const rulesFile = d('rules.json');
    await writeFile(rulesFile, serializeRules(rules), { mode: 0o600 });
    const protectedFile = d('secrets', 'github-token');
    const plan = {
      nr: SYS, scratch: d('scratch'), protectedFile, outsidePid: outside.pid, port, oAsync: 0o20000, // O_ASYNC on x86_64 and aarch64
      read: [d('state', 'minions.db'), d('state'), protectedFile, d('secrets'), d('common', 'config'), d('common', 'refs'), d('worktrees', 'other', 'README'), d('lease'), d('other-lease', 'scratch'), root],
      write: [d('state'), d('secrets'), d('common', 'objects'), d('common', 'refs', 'heads'), d('worktrees', 'other'), d('lease'), d('other-lease', 'scratch'), root],
    };
    await writeFile(d('scratch', 'plan.json'), JSON.stringify(plan));
    await writeFile(d('scratch', 'attack.pl'), ATTACK);
    const before = await stat(protectedFile);
    const nice = async () => Number((await readFile(`/proc/${outside.pid}/stat`, 'utf8')).split(') ')[1]!.split(' ')[16]);
    const affinity = async () => /Cpus_allowed_list:\s*(\S+)/.exec(await readFile(`/proc/${outside.pid}/status`, 'utf8'))?.[1];
    const niceBefore = await nice();
    const affinityBefore = await affinity();
    const argv = sandboxArgv(rulesFile, [PERL!, d('scratch', 'attack.pl'), d('scratch', 'plan.json')], { bin, scratchDir: d('scratch'), secretValues: ['not-a-real-token'] });
    const r = await run(argv[0]!, argv.slice(1), { allowFailure: true, timeoutMs: 30_000 });
    const results = new Map<string, { ok: boolean; detail: string }>();
    for (const line of r.stdout.split('\n')) {
      const [name, outcome, detail] = line.split('\t');
      if (name && outcome) results.set(name, { ok: outcome === 'ok', detail: detail ?? '' });
    }
    const after = await stat(protectedFile).catch(() => null);
    return {
      r, results, plan,
      outsideView: {
        tcp: [...tcpSeen],
        signals: [...outside.signals],
        niceChanged: (await nice()) !== niceBefore,
        affinityChanged: (await affinity()) !== affinityBefore,
        protectedMetadataChanged: !after || after.mode !== before.mode || after.mtimeMs !== before.mtimeMs,
      },
    };
  }

  const roles: SandboxRoleView[] = [
    { name: 'engineer', contract: 'producer', harness: 'codex' },
    { name: 'reviewer', contract: 'gate', harness: 'codex' },
  ];

  for (const role of roles) {
    describe(`${role.name} (${role.contract})`, () => {
      let out: Awaited<ReturnType<typeof attack>>;
      beforeAll(async () => { tcpSeen.length = 0; outside.signals.length = 0; out = await attack(role); }, 60_000);

      it('the attack script ran to completion inside the sandbox', () => {
        expect(out.r.stdout).toContain('\nend\n');
        expect(out.r.code).toBe(0);
      });

      it('no read of state, secrets, the shared repo, other worktrees or another lease scratch', () => {
        for (const p of out.plan.read) expect(out.results.get(`read:${p}`), p).toMatchObject({ ok: false });
        for (const n of ['read:via-symlink', 'read:via-proc-self-root']) expect(out.results.get(n), n).toMatchObject({ ok: false });
      });

      it('no write outside the scratch dir (create, mkdir, append, truncate, unlink, rename, hard link)', () => {
        for (const p of out.plan.write) {
          expect(out.results.get(`create:${p}`), p).toMatchObject({ ok: false });
          expect(out.results.get(`mkdir:${p}`), p).toMatchObject({ ok: false });
        }
        for (const n of ['append:protected', 'truncate:protected', 'unlink:protected', 'rename:protected', 'hardlink:protected->scratch', 'rename:protected->scratch']) {
          expect(out.results.get(n), n).toMatchObject({ ok: false });
        }
      });

      it('no signal, ptrace, pidfd or /proc access to a process outside the sandbox', () => {
        for (const n of ['kill0:outside', 'kill-usr1:outside', 'tgkill0:outside', 'read:/proc/outside/environ', 'read:/proc/outside/mem',
          'readlink:/proc/outside/cwd', 'ptrace-seize:outside', 'pidfd_send_signal:outside', 'pidfd_getfd:outside']) {
          expect(out.results.get(n), n).toMatchObject({ ok: false });
        }
        expect(out.outsideView.signals).toEqual([]); // includes SIGIO through F_SETOWN + O_ASYNC
      });

      it('no unix, packet, raw, AF_ALG or vsock socket; no io_uring; no user namespace', () => {
        for (const n of ['socket:AF_UNIX', 'socket:AF_UNIX-dgram', 'socket:AF_PACKET', 'socket:raw-icmp', 'socket:raw-ipv6', 'socket:AF_ALG', 'socket:AF_VSOCK', 'io_uring_setup', 'unshare:user']) {
          expect(out.results.get(n), n).toMatchObject({ ok: false });
        }
        expect(out.results.get('io_uring_setup')?.detail).toMatch(/not implemented/i); // the helper's own ENOSYS, not Docker's EPERM
      });

      it('no TCP connect to a port outside tcpConnectPorts (IPv4, IPv6, IPv4-mapped)', () => {
        for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(out.results.get(`tcp-connect:${a}`), a).toMatchObject({ ok: false });
      });

      it('TCP Fast Open does not reach a port outside tcpConnectPorts (sendto MSG_FASTOPEN and setsockopt TCP_FASTOPEN_CONNECT)', () => {
        expect(out.results.get('tcp-fastopen:127.0.0.1')).toMatchObject({ ok: false });
        // The client-side fast-open path armed through setsockopt must also be refused, and the follow-up
        // connect to the disallowed port must still be blocked by Landlock.
        expect(out.results.get('tcp-fastopen-connect:setsockopt'), 'setsockopt TCP_FASTOPEN_CONNECT').toMatchObject({ ok: false });
        expect(out.results.get('tcp-fastopen-connect:connect'), 'connect after TFO setsockopt').toMatchObject({ ok: false });
        expect(out.outsideView.tcp).toEqual([]);
      });

      it('no chmod, utime or setxattr on a protected file (incl. the user-notification routes: symlink and /proc/self/root)', () => {
        for (const n of ['chmod:protected', 'chmod:via-symlink', 'chmod:via-proc-self-root', 'utime:protected', 'setxattr:protected']) {
          expect(out.results.get(n), n).toMatchObject({ ok: false });
        }
        expect(out.outsideView.protectedMetadataChanged).toBe(false);
        // Positive control: the chmod user-notification handler must still allow a chmod inside the scratch
        // dir, else it would be a blanket deny that breaks the harness's own git.
        expect(out.results.get('chmod:scratch-allowed'), 'chmod inside scratch').toMatchObject({ ok: true });
      });

      it('no setpriority, sched_setaffinity or ioprio_set on a process outside the sandbox', () => {
        for (const n of ['setpriority:outside', 'sched_setaffinity:outside', 'ioprio_set:outside']) expect(out.results.get(n), n).toMatchObject({ ok: false });
        expect(out.outsideView.niceChanged || out.outsideView.affinityChanged).toBe(false);
      });
    });
  }

  it('supervisor: nothing survives the harness (double fork + setsid, nested subreaper, new process group, runaway fork chain)', async () => {
    const scratch = join(root, 'engineer', 'scratch');
    const tag = String(4000 + (process.pid % 1000));
    const script = join(scratch, 'daemonize.pl');
    await writeFile(script, String.raw`
use POSIX (); $| = 1; my $t = shift;
if (!fork) { POSIX::setsid(); if (!fork) { $SIG{$_} = 'IGNORE' for qw(TERM HUP INT); exec 'sleep', "${'$'}{t}1" } exit 0 }
if (!fork) { syscall(${process.arch === 'arm64' ? 167 : 157}, 36, 1, 0, 0, 0); if (!fork) { if (!fork) { exec 'sleep', "${'$'}{t}2" } exit 0 } sleep 600; exit }
if (!fork) { setpgrp(0, 0); exec 'sleep', "${'$'}{t}3" }
if (!fork) { while (1) { my $p = fork; exit 0 if $p; POSIX::setsid(); select(undef, undef, undef, 0.001); } }
sleep 1; exit 0;
`);
    const rulesFile = join(root, 'engineer', 'rules.json');
    const leftovers = () => execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').map((l) => l.trim())
      .filter((l) => /^\d+ /.test(l) && (l.includes(` sleep ${tag}`) || l.includes(script)));
    const t0 = Date.now();
    try {
      // stdio ignored: a leftover holding an inherited pipe must not make this wait for EOF.
      const child = spawn(bin, ['--rules', rulesFile, '--', PERL!, script, tag], { stdio: 'ignore' });
      const code = await new Promise<number | null>((r) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); r(null); }, 15_000);
        child.on('exit', (c) => { clearTimeout(timer); r(c); });
      });
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(leftovers()).toEqual([]);
    } finally {
      // A broken helper leaves the tree behind (the runaway chain keeps forking): sweep it.
      for (let i = 0; i < 200 && leftovers().length; i++) for (const l of leftovers()) { try { process.kill(Number(l.split(' ')[0]), 'SIGKILL'); } catch { /* gone */ } }
    }
  }, 40_000);

  // The chmod user-notification handler must still let the harness's own git work: git chmods its loose
  // objects, lock files and the executable bit on checked-out files, all inside the writable worktree.
  const GIT = ['/usr/bin/git', '/bin/git'].find((p) => existsSync(p));
  const SH = ['/bin/sh'].find((p) => existsSync(p));
  it.skipIf(!GIT || !SH)('git still works inside the sandbox (path chmod on files in the worktree is allowed)', async () => {
    const base = join(root, 'git');
    const scratch = join(base, 'scratch');
    await mkdir(join(base, 'common', 'objects'), { recursive: true });
    await mkdir(scratch, { recursive: true });
    const rules = buildSandboxRules({
      role: { name: 'engineer', contract: 'producer', harness: 'codex' }, leaseId: 'lease-git',
      layout: { scratchDir: scratch, gitObjectsDir: join(base, 'common', 'objects'), harnessDir: null },
      protectedPaths: [join(base, 'common')],
    });
    const rulesFile = join(base, 'rules.json');
    await writeFile(rulesFile, serializeRules(rules), { mode: 0o600 });
    const script = String.raw`
set -e
export HOME="${scratch}" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
cd "${scratch}"
git init -q repo
cd repo
printf '#!/bin/sh\nexit 0\n' > run.sh
chmod 0755 run.sh
echo data > file.txt
git add -A
git commit -qm first
echo changed > file.txt
git checkout -- file.txt
test -x run.sh && echo EXEC_BIT_KEPT
echo "content: $(cat file.txt)"
echo GIT_OK
`;
    const r = await run(bin, ['--rules', rulesFile, '--', SH!, '-c', script], { allowFailure: true, timeoutMs: 30_000 });
    expect(r.stdout, r.stderr).toContain('GIT_OK');
    expect(r.stdout).toContain('EXEC_BIT_KEPT');
    expect(r.stdout).toContain('content: data');
    expect(r.code).toBe(0);
  }, 40_000);
});
