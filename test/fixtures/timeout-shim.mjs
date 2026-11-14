// A stand-in for coreutils `timeout <seconds> <command> [args...]` on hosts that have none (macOS), used by
// runHookCommand in test/helpers.ts. The generated hook commands (`timeout 20 minions hook ... || exit 2`) run
// inside the Linux runtime image, which has coreutils; the tests run them on the host too, so the exit codes the
// wrapper sees must be the same: the command's own status, 128+signal when it was killed, 124 when the time ran
// out, 127 when it cannot be found and 126 when it cannot be run. As coreutils does, the command runs in its own
// process group and the whole group gets SIGTERM on expiry, so a grandchild holding the output pipe dies too.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const [seconds, cmd, ...args] = process.argv.slice(2);
if (!cmd || !(Number(seconds) >= 0)) { process.stderr.write('timeout: usage: timeout <seconds> <command> [args...]\n'); process.exit(125); }
const child = spawn(cmd, args, { stdio: 'inherit', detached: true });
let expired = false;
const timer = setTimeout(() => {
  expired = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
}, Number(seconds) * 1000);
child.on('error', (e) => {
  process.stderr.write(`timeout: failed to run command '${cmd}': ${e.code === 'ENOENT' ? 'No such file or directory' : e.message}\n`);
  process.exit(e.code === 'ENOENT' ? 127 : 126);
});
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  process.exit(expired ? 124 : code ?? 128 + (constants.signals[signal] ?? 0));
});
