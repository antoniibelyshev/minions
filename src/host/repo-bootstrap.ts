// New projects (docs/design/autonomy.md phase 6): `minions init` / `minions setup` in an empty directory create the
// Git repository themselves (`git init -b main` and an empty first commit), so the owner only makes the directory; the
// coordinator then sets up the stack, tests and flows. A non-empty directory that is not a repository is refused:
// committing files minions has not seen (an .env, build output) is the owner's call.
// A repository without commits gets the empty first commit too: the agents' workspace is seeded from the base branch.
import { readdir } from 'node:fs/promises';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import type { Runner } from './docker.js';

/** Entries an empty new directory may already hold. */
const IGNORABLE = new Set(['.DS_Store']);

export async function bootstrapRepo(path: string, o: { dryRun?: boolean; runner?: Runner } = {}): Promise<string[]> {
  const runner = o.runner ?? run;
  const git = (args: string[]) => runner('git', args, { cwd: path, allowFailure: true, timeoutMs: 30_000 });
  const inRepo = (await git(['rev-parse', '--show-toplevel'])).code === 0;
  if (inRepo && (await git(['rev-parse', 'HEAD'])).code === 0) return [];
  if (!inRepo) {
    const entries = (await readdir(path)).filter((e) => !IGNORABLE.has(e));
    if (entries.length) {
      throw new MinionsError('PRECONDITION', `${path} is not a Git repository and is not empty.`,
        'Commit what belongs in the project first (`git init -b main && git add <files> && git commit`), or run minions in an empty directory to start a new project.');
    }
  }
  const what = inRepo ? 'an empty first commit (the repository has no commits)' : 'a Git repository on main with an empty first commit';
  if (o.dryRun) {
    if (!inRepo) throw new MinionsError('PRECONDITION', `${path} is not a Git repository yet; without --dry-run minions creates ${what} here.`, 'Rerun without --dry-run.');
    return [`Would create ${what}.`];
  }
  const ident = async (k: string) => (await git(['config', '--get', k])).stdout.trim();
  if (!(await ident('user.name')) || !(await ident('user.email'))) {
    throw new MinionsError('PRECONDITION', `Creating ${what} needs a Git identity.`, 'Run `git config --global user.name "…"` and `git config --global user.email "…"`, then rerun.');
  }
  const step = async (args: string[], input?: string) => {
    const r = await runner('git', args, { cwd: path, allowFailure: true, timeoutMs: 30_000, ...(input !== undefined ? { input } : {}) });
    if (r.code !== 0) throw new MinionsError('PRECONDITION', `git ${args[0]} failed in ${path}.`, r.stderr.trim().split('\n').slice(-1)[0] || undefined);
    return r.stdout.trim();
  };
  if (!inRepo) await step(['init', '-b', 'main']);
  // Plumbing, not `git commit`: an empty tree whatever the index holds (staged files in an existing repository stay staged).
  const tree = await step(['mktree'], '');
  const commit = await step(['commit-tree', tree, '-m', 'Initial commit']);
  await step(['update-ref', 'HEAD', commit, '']);
  return [`Created ${what}.`];
}
