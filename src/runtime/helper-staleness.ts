// The detached helpers (`minions coordinator supervise`, `minions work dispatch`) run for days on the code they were
// started with. When an upgrade installs a new build and regenerates the runtime config with keys that code does not
// know (`budgets.dailyTokens: unknown field`), every config load of the old helper fails: the dispatcher used to log
// "pass failed" forever and the supervisor kept its last config, while both still held their lock, so the wrapper's
// watches never replaced them. `minions upgrade` stops them itself (src/host/upgrade.ts, the helpers step); this guard
// is the backstop for every other way the code or the config moves under a running helper.
//
// Rule: a config load that fails while
//   (a) the CLI bundle this process runs (realpath of argv[1], dist/cli.js) changed on disk since it started, or
//   (b) the config file's configRevision differs from the revision of the last config this process validated,
// means the config was written for other code: the helper exits (with a log line) and releases its lock, and the
// wrapper's watch starts it again through the shim, on the installed build.
// A config that fails before this process ever validated one, with unchanged code, keeps the old behaviour (log and
// retry): a restart would run the same code on the same file, so exiting would only churn.
import { readFileSync, realpathSync, statSync } from 'node:fs';

/** Identity of a file on disk: a reinstall or rebuild replaces it (new inode) or rewrites it (size, mtime). */
export interface CodeStamp { path: string; dev: number; ino: number; size: number; mtimeMs: number }

/** The stamp of `path` (default: the running CLI bundle); null when unreadable. */
export function codeStamp(path: string | undefined = process.argv[1]): CodeStamp | null {
  if (!path) return null;
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    return { path: real, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  } catch { return null; }
}

/** The configRevision of a config file read without validation (null: unreadable, not JSON, or no revision). */
export function rawConfigRevision(path: string): number | null {
  try {
    const v = (JSON.parse(readFileSync(path, 'utf8')) as { configRevision?: unknown }).configRevision;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

export interface StaleConfigGuard {
  /** A config load succeeded: remember its revision. */
  valid(cfg: { configRevision?: unknown }): void;
  /** A config load failed with `err`: why this process should exit (its code is stale), or null to keep retrying. */
  invalid(err: unknown): string | null;
}

export interface StaleGuardDeps {
  /** The runtime config file (its revision is read without validation). */
  configPath: string;
  /** The stamp taken at start (default: codeStamp() now). */
  started?: CodeStamp | null;
  /** Re-reads the stamp of the same file (default codeStamp). */
  stampOf?: (path: string) => CodeStamp | null;
  revisionOf?: (path: string) => number | null;
}

const sameStamp = (a: CodeStamp, b: CodeStamp | null) => !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

export function staleConfigGuard(o: StaleGuardDeps): StaleConfigGuard {
  const started = o.started === undefined ? codeStamp() : o.started;
  const stampOf = o.stampOf ?? codeStamp;
  const revisionOf = o.revisionOf ?? rawConfigRevision;
  let validRevision: number | null = null;
  return {
    valid(cfg) { if (typeof cfg.configRevision === 'number') validRevision = cfg.configRevision; },
    invalid(err) {
      const msg = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);
      if (started && !sameStamp(started, stampOf(started.path))) {
        return `the runtime config does not load (${msg}) and the minions CLI this process runs (${started.path}) changed on disk since it started (an upgrade?)`;
      }
      const now = revisionOf(o.configPath);
      if (validRevision !== null && now !== null && now !== validRevision) {
        return `the runtime config (configRevision ${now}) does not load (${msg}); this process last loaded configRevision ${validRevision}, so the config was written for other code (an upgrade?)`;
      }
      return null;
    },
  };
}
