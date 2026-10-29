// Hang guard for the fail-closed PreToolUse hooks (task-2.7; portable since task-4).
//
// A stuck `minions hook` must still block: Claude Code's own hook timeout is a non-blocking error that lets the
// call through, so the wrapper kills the hook first and `|| exit 2` turns that into a block. coreutils `timeout`
// is used when present (Linux, the container); stock macOS has none, so the fallback is a small perl watchdog
// (perl ships with macOS and is perl-base, Essential, in the Debian image). The watchdog runs the hook in its own
// process group, kills that group with SIGKILL after the deadline (exit 124, like coreutils), and otherwise passes
// the exit status through (128+N for a signal). A missing perl exits 127, which `|| exit 2` blocks as well.

/**
 * Seconds before the guard kills a stuck hook. Claude Code's own hook `timeout` (HOOK_SETTINGS_TIMEOUT_S) must be
 * larger, otherwise it fires first and the timed-out hook lets the call through.
 */
export const HOOK_WRAPPER_TIMEOUT_S = 20;
export const HOOK_SETTINGS_TIMEOUT_S = 30;

/** The perl fallback for `timeout <seconds> <cmd...>`; no single quotes inside, so it sits in one sh word. */
const PERL_WATCHDOG = 'perl -e \'$t=shift;$p=fork;defined $p or exit 127;'
  + 'if(!$p){setpgrp(0,0);exec @ARGV;print STDERR "$ARGV[0]: $!\\n";exit 127}'
  + 'setpgrp($p,$p);$SIG{ALRM}=sub{kill "KILL",-$p;exit 124};alarm $t;waitpid $p,0;'
  + 'exit($?&127?128+($?&127):$?>>8)\'';

/** The test that picks coreutils `timeout` over the perl fallback (tests replace it to force the fallback). */
export const HANG_GUARD_TIMEOUT_TEST = 'command -v timeout >/dev/null 2>&1';

/** `cmd` (plain words, no shell operators) under the hang guard, as one sh compound command; stdin passes through. */
export function hangGuarded(cmd: string, seconds = HOOK_WRAPPER_TIMEOUT_S): string {
  return `{ if ${HANG_GUARD_TIMEOUT_TEST}; then timeout ${seconds} ${cmd}; else ${PERL_WATCHDOG} ${seconds} ${cmd}; fi; }`;
}
