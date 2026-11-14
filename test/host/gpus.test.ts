// container.gpus: NVIDIA GPUs in the project container (Docker on macOS cannot pass Metal through).
import { describe, expect, it } from 'vitest';
import { composeYaml, nvidiaHost, resolveGpus } from '../../src/host/docker.js';
import { ProjectJsonSchema, type ProjectJson } from '../../src/host/project.js';

const project = (gpus?: 'nvidia'): ProjectJson => ProjectJsonSchema.parse({
  version: 1, projectId: '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f', repoPath: '/r', gitCommonDir: '/r/.git', visibility: 'private',
  mode: 'independent', imageTag: 'minions-runtime:0.1.0', baseBranch: 'main', remoteUrl: null, gitIdentity: { name: 'Ada', email: 'ada@example.com' },
  container: { cpus: 4, memoryMiB: 6144, pidsLimit: 512, publishPorts: [], network: 'outbound-internet', ...(gpus ? { gpus } : {}) },
});

describe('container.gpus', () => {
  it('auto takes NVIDIA GPUs only on a Linux host with the driver and the container toolkit', () => {
    const files = (...present: string[]) => (p: string) => present.includes(p);
    expect(nvidiaHost('linux', files('/dev/nvidiactl', '/usr/bin/nvidia-container-toolkit'))).toBe(true);
    expect(nvidiaHost('linux', files('/dev/nvidiactl'))).toBe(false);
    expect(nvidiaHost('linux', files('/usr/bin/nvidia-container-runtime-hook'))).toBe(false);
    expect(nvidiaHost('darwin', () => true)).toBe(false);
    expect([undefined, 'auto', 'nvidia', 'none'].map((s) => resolveGpus(s as never, () => true))).toEqual(['nvidia', 'nvidia', 'nvidia', undefined]);
    expect([undefined, 'auto', 'nvidia', 'none'].map((s) => resolveGpus(s as never, () => false))).toEqual([undefined, undefined, 'nvidia', undefined]);
  });

  it('compose reserves every NVIDIA GPU with compute capabilities; nothing without', () => {
    const y = composeYaml(project('nvidia'), { mode: 'owner' });
    expect(y).toContain([
      '    deploy:', '      resources:', '        reservations:', '          devices:',
      '            - driver: "nvidia"', '              count: "all"', '              capabilities: ["gpu"]'].join('\n'));
    expect(y).toContain('      NVIDIA_DRIVER_CAPABILITIES: "compute,utility"');
    const none = composeYaml(project(), { mode: 'owner' });
    expect(none).not.toMatch(/deploy:|nvidia/i);
  });
});
