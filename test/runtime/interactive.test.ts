// `minions session new|list|attach` (docs/design/autonomy.md Decision 13): extra interactive coordinators, each its own
// tmux session on the runtime's server, scoped by MINIONS_SESSION=session:<name>.
import { describe, expect, it } from 'vitest';
import { attachArgs, checkSessionName, newSessionCommand, nextSessionName, parseTmuxSessions } from '../../src/runtime/interactive.js';
import { parseScope } from '../../src/runtime/session-scope.js';

describe('interactive coordinator sessions', () => {
  it('names default to the lowest free number from 2; a given name is checked', () => {
    expect(nextSessionName([])).toBe('2');
    expect(nextSessionName(['2', '3', 'docs', '5'])).toBe('4');
    expect(checkSessionName('docs_2')).toBe('docs_2');
    for (const bad of ['', '-x', 'a:b', 'a.b', 'a b', 'x'.repeat(33)]) expect(() => checkSessionName(bad), bad).toThrow(/Invalid session name/);
  });

  it('lists only the extra sessions of the tmux server', () => {
    const out = 'coordinator 1761904800 1\nsession-2 1761904860 0\nsession-docs 1761904920 1\nsession-bad.name 1 0\nother 1 0\n';
    expect(parseTmuxSessions(out)).toEqual([
      { name: '2', key: 'session:2', tmux: 'session-2', created: '2025-10-31T10:01:00.000Z', attached: false },
      { name: 'docs', key: 'session:docs', tmux: 'session-docs', created: '2025-10-31T10:02:00.000Z', attached: true },
    ]);
  });

  it('starts a detached tmux session on the runtime server running the interactive coordinator; attaches by exact name', () => {
    const paths = { tmuxSocket: 'minions-p1', repo: '/w/repo' };
    expect(newSessionCommand(paths, '2')).toEqual({ cmd: 'tmux', cwd: '/w/repo',
      args: ['-L', 'minions-p1', '-u', 'new-session', '-d', '-s', 'session-2', '-c', '/w/repo', '--', 'minions', 'coordinator', 'interactive', 'session:2'] });
    expect(newSessionCommand({ tmuxSocket: null, repo: '/workspace/repo' }, 'x').args.slice(0, 3)).toEqual(['-u', 'new-session', '-d']);
    expect(attachArgs(paths, 'docs')).toEqual(['-L', 'minions-p1', 'attach-session', '-t', '=session-docs']);
    expect(() => newSessionCommand(paths, 'a;b')).toThrow();
  });

  it('session:<name> is a scope of its own (no DB session row)', () => {
    expect(parseScope('session:2')).toEqual({ key: 'session:2', kind: 'interactive', taskId: null });
    expect(() => parseScope('session:a b')).toThrow();
  });
});
