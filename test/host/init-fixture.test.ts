// task-104.3: the shared init fixture (initFromTemplate in ./fixtures.ts) must hand every test the same install a real
// `minions init --yes` writes, at the test's own paths, and copies must never share state.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPaths, shortId } from '../../src/core/paths.js';
import { runInit } from '../../src/host/install.js';
import { loadProjectJson } from '../../src/host/project.js';
import { dockerUp, git, initFromTemplate, makeRepo, withHome } from './fixtures.js';

let envs: ReturnType<typeof withHome>[] = [];
const home = () => { const e = withHome(); envs.push(e); return e; };
beforeEach(() => { envs = []; });
afterEach(() => { for (const e of envs.reverse()) e.cleanup(); });

/** Every file under root (git objects and the index excluded) with its content, paths and the project id normalized. */
function snapshot(root: string, projectId: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!(dir.endsWith('.git') && e.name === 'objects')) walk(p); continue; }
      if (p.endsWith(join('.git', 'index'))) continue;
      const rel = relative(root, p).split(projectId).join('<id>');
      out[`${rel} ${(statSync(p).mode & 0o777).toString(8)}`] = readFileSync(p, 'utf8').split(root).join('<root>').split(projectId).join('<id>').split(shortId(projectId)).join('<short>')
        // Hashes of files that hold the project id differ; the rerun below checks the copy's manifest hashes.
        .replace(/"sha256": "[0-9a-f]{64}"/g, '"sha256": "<sha>"');
    }
  };
  walk(root);
  return out;
}

describe.each(['private', 'shared'] as const)('initFromTemplate (%s)', (visibility) => {
  it('writes what a real init writes, at the new paths, and a rerun of init finds nothing to change', async () => {
    const real = home();
    const r = await runInit({ mode: 'independent', path: makeRepo(real.root), yes: true, visibility, dockerProbe: dockerUp });
    const expected = snapshot(real.root, r.plan.projectId);
    // The first call builds the template, the second copies it: both must match the real install.
    for (let i = 0; i < 2; i++) {
      const env = home();
      const { repo, projectId } = await initFromTemplate(env.root, { visibility });
      expect(repo).toBe(join(env.root, 'repo'));
      expect(snapshot(env.root, projectId)).toEqual(expected);
      const project = await loadProjectJson(projectId);
      expect(project.repoPath).toBe(repo);
      const again = await runInit({ mode: 'independent', path: repo, yes: true, visibility, dockerProbe: dockerUp });
      expect(again.plan.projectId).toBe(projectId);
      expect(again.plan.writes.filter((w) => !['unchanged', 'keep'].includes(w.action))).toEqual([]);
    }
  });

  it('each copy is private: changes to one never reach the next', async () => {
    const a = home();
    const first = await initFromTemplate(a.root, { visibility });
    writeFileSync(projectPaths(first.projectId).configLocalJson, '{"execution":{"maxActiveTasks":9}}\n');
    writeFileSync(join(first.repo, 'README.md'), 'changed\n');
    git(first.repo, 'commit', '-qam', 'change');
    a.cleanup(); envs = envs.filter((e) => e !== a);
    const b = home();
    const second = await initFromTemplate(b.root, { visibility });
    expect(readFileSync(join(second.repo, 'README.md'), 'utf8')).toBe('# demo\n');
    expect(git(second.repo, 'log', '--format=%s')).toBe('init');
    expect(() => statSync(projectPaths(second.projectId).configLocalJson)).toThrow();
  });
});

it('a second project in the same home runs the real init (its own project id)', async () => {
  const env = home();
  const one = await initFromTemplate(env.root);
  const two = await initFromTemplate(env.root, { name: 'other' });
  expect(two.projectId).not.toBe(one.projectId);
  expect((await loadProjectJson(two.projectId)).repoPath).toBe(join(env.root, 'other'));
  expect((await loadProjectJson(one.projectId)).repoPath).toBe(join(env.root, 'repo'));
});
