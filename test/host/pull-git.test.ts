// `minions pull`: the base fast-forward against real temp git repos (integration tier: runs git). Untracked files do
// not block it unless the incoming range adds a path one occupies; tracked changes still do.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fastForwardBase } from '../../src/host/pull.js';
import { git, makeRepo, withHome } from './fixtures.js';

describe('pull: base fast-forward in a real checkout', () => {
  let home: ReturnType<typeof withHome>;
  beforeEach(() => { home = withHome(); });
  afterEach(() => home.cleanup());

  /** main checked out, refs/remotes/minions/main one commit ahead that adds `added` (as an export leaves it). */
  function repo(added: Record<string, string> = { 'feature.txt': 'agent\n' }) {
    const r = makeRepo(home.root);
    const base = git(r, 'rev-parse', 'HEAD');
    git(r, 'checkout', '-q', '-b', 'tmp');
    for (const [p, c] of Object.entries(added)) { mkdirSync(join(r, p, '..'), { recursive: true }); writeFileSync(join(r, p), c); }
    git(r, 'add', '.');
    git(r, 'commit', '-q', '-m', 'agent work');
    const ahead = git(r, 'rev-parse', 'HEAD');
    git(r, 'checkout', '-q', 'main');
    git(r, 'update-ref', 'refs/remotes/minions/main', ahead);
    git(r, 'branch', '-q', '-D', 'tmp');
    return { r, base, ahead };
  }

  it('fast-forwards with only untracked files present (the owner\'s .minions/) and keeps them', async () => {
    const s = repo();
    mkdirSync(join(s.r, '.minions'));
    writeFileSync(join(s.r, '.minions', 'config.json'), '{}\n');
    writeFileSync(join(s.r, '.minions', 'goals.md'), '# goals\n');
    const res = await fastForwardBase(s.r, 'main');
    expect(res).toMatchObject({ action: 'fast-forward', applied: true, from: s.base, to: s.ahead });
    expect(git(s.r, 'rev-parse', 'main')).toBe(s.ahead);
    expect(readFileSync(join(s.r, '.minions', 'goals.md'), 'utf8')).toBe('# goals\n');
  });

  it('refuses and names the path when the range adds a file an untracked one occupies', async () => {
    const s = repo({ '.minions/goals.md': 'from the agents\n' });
    mkdirSync(join(s.r, '.minions'));
    writeFileSync(join(s.r, '.minions', 'goals.md'), '# mine\n');
    const res = await fastForwardBase(s.r, 'main');
    expect(res).toMatchObject({ action: 'skipped', applied: false });
    expect(res.reason).toMatch(/minions\/main adds \.minions\/goals\.md, which an untracked file in the checkout occupies/);
    expect(git(s.r, 'rev-parse', 'main')).toBe(s.base);
    expect(readFileSync(join(s.r, '.minions', 'goals.md'), 'utf8')).toBe('# mine\n');
  });

  it('refuses when an untracked file sits where the range needs a directory', async () => {
    const s = repo({ 'docs/new/page.md': 'x\n' });
    mkdirSync(join(s.r, 'docs'), { recursive: true });
    writeFileSync(join(s.r, 'docs', 'new'), 'a file\n');
    const res = await fastForwardBase(s.r, 'main');
    expect(res).toMatchObject({ action: 'skipped', applied: false });
    expect(res.reason).toMatch(/adds docs\/new,/);
  });

  it('still refuses on a tracked modification', async () => {
    const s = repo();
    writeFileSync(join(s.r, 'README.md'), '# local edit\n');
    const res = await fastForwardBase(s.r, 'main');
    expect(res).toMatchObject({ action: 'skipped', applied: false, reason: expect.stringMatching(/1 uncommitted change\(s\) to tracked files/) });
    expect(git(s.r, 'rev-parse', 'main')).toBe(s.base);
  });
});
