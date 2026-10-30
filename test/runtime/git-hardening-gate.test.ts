// Security (task-71): the gate's git reader (gateGit) turns off replace objects, grafts, shallow files and the
// commit graph and passes only allowlisted variables. Unit tier: an injected runner records the args and env.
// test/runtime/gate-history-rewrite.test.ts shows with real git that the gate then ignores those rewrites.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateGit, gateGitArgs, gateGitEnv, GATE_HOME } from '../../src/runtime/git-hardening.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('gateGit (task-71)', () => {
  it('runs with replace objects, grafts, shallow and commit graph off and only allowlisted variables', async () => {
    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    await gateGit('/repo', ['diff', '--name-only', 'a...b'], true, {
      env: { PATH: '/usr/bin', HOME: '/home/agent', XDG_CONFIG_HOME: '/x', GIT_DIR: '/evil', GIT_GRAFT_FILE: '/evil/g', GIT_CONFIG_PARAMETERS: "'a'='b'", GIT_NO_REPLACE_OBJECTS: '' },
      run: async (_c, args, o) => { seen.push({ args, env: o.env }); return { code: 0, stdout: '', stderr: '' }; },
    });
    const { args, env } = seen[0]!;
    expect(args.slice(-3)).toEqual(['diff', '--name-only', 'a...b']);
    for (const c of ['core.useReplaceRefs=false', 'core.commitGraph=false', 'core.hooksPath=/dev/null', 'core.attributesFile=/dev/null', 'diff.external=']) {
      expect(args[args.indexOf(c) - 1]).toBe('-c');
    }
    expect(env).toMatchObject({
      GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null', GIT_SHALLOW_FILE: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', HOME: GATE_HOME, PATH: '/usr/bin',
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it('gateGitArgs ends with --no-pager and gateGitEnv keeps no inherited GIT_* variable', () => {
    expect(gateGitArgs().at(-1)).toBe('--no-pager');
    const env = gateGitEnv({ PATH: '/bin', GIT_WORK_TREE: '/w', GIT_COMMON_DIR: '/c', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/a' });
    expect(Object.keys(env).filter((k) => k.startsWith('GIT_')).sort()).toEqual([
      'GIT_ASKPASS', 'GIT_ATTR_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_GRAFT_FILE', 'GIT_NO_REPLACE_OBJECTS',
      'GIT_OPTIONAL_LOCKS', 'GIT_SHALLOW_FILE', 'GIT_TERMINAL_PROMPT',
    ]);
  });
});
