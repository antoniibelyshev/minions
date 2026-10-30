// Template git repositories (task-104): most tests start from the same one-commit repository, and building it
// is several git processes (init, config, add, commit, rev-parse). Under load each spawn costs tens of
// milliseconds, and the suite builds hundreds of these. Each worker builds a template once per distinct
// setup and copies it; the copy is the same repository (same commit and SHA) at the new path. Module state is
// per test file, so the templates live in that file's TMPDIR and go with it.
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const templates = new Map<string, { dir: string; value: string }>();

/** Env that changes what git writes into the template (identity, dates, config): part of the cache key. */
const GIT_ENV = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'HOME'];

/**
 * Creates `dir` as a copy of the template built by `build(templateDir)` (which returns a value, e.g. the
 * commit SHA, returned again for every copy). Falls back to building in place when `dir` already has content,
 * so a test that prepared files before creating the repo still gets them committed as before.
 */
export function fromTemplate(key: string, dir: string, build: (dir: string) => string): string {
  if (existsSync(dir) && readdirSync(dir).length > 0) return build(dir);
  const k = `${key}\0${GIT_ENV.map((v) => process.env[v] ?? '').join('\0')}`;
  let t = templates.get(k);
  // Rebuilt if a test removed it.
  if (!t || !existsSync(t.dir)) {
    const dir = join(mkdtempSync(join(tmpdir(), 'minions-repo-template-')), 'repo');
    const value = build(dir);
    // Sample hooks are inert; dropping them makes the copy a few files instead of a dozen more (the dir stays).
    const hooks = join(dir, '.git', 'hooks');
    if (existsSync(hooks)) for (const h of readdirSync(hooks)) if (h.endsWith('.sample')) rmSync(join(hooks, h));
    t = { dir, value };
    templates.set(k, t);
  }
  cpSync(t.dir, dir, { recursive: true });
  return t.value;
}
