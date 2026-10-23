// Linux host diagnostics for `minions doctor` (Docker Engine without Docker Desktop). Pure functions
// over probed facts, so every branch is testable with fakes; macOS keeps its Docker Desktop hints.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hostRoot } from '../core/paths.js';
import type { DockerStatus } from './discovery.js';
import type { Runner } from './docker.js';
import { CONTAINER_UID, probeSecretsAccess, type SecretsAccess } from './secrets-access.js';

export { CONTAINER_UID };

export interface LinuxHostFacts {
  /** Host user running the CLI (process.getuid), null when unknown. */
  uid: number | null;
  /** `docker info` SecurityOptions (e.g. "name=seccomp,profile=builtin", "name=rootless", "name=selinux"); null when unknown. */
  securityOptions: string[] | null;
  /** `getenforce` result; null when SELinux tools are absent or the probe failed. */
  selinux: 'enforcing' | 'permissive' | 'disabled' | null;
  /** DOCKER_HOST of the CLI environment, null when unset. */
  dockerHost: string | null;
  /** $XDG_RUNTIME_DIR/docker.sock when that rootless Docker socket exists, else null. */
  rootlessSocket: string | null;
  /** `docker-compose --version` output when only the legacy v1 binary is installed, else null. */
  composeV1: string | null;
  /** How the container reads the secret files for this host user (from /etc/passwd + /etc/group); null when unknown. */
  secretsAccess: SecretsAccess | null;
}

export const unknownLinuxFacts = (): LinuxHostFacts =>
  ({ uid: null, securityOptions: null, selinux: null, dockerHost: null, rootlessSocket: null, composeV1: null, secretsAccess: null });

export interface FactOptions {
  env?: NodeJS.ProcessEnv;
  uid?: number | null;
  exists?: (path: string) => Promise<boolean>;
  /** Reads /etc/passwd and /etc/group (tests inject fakes); null when unreadable. */
  readFile?: (path: string) => string | null;
}

const fileExists = (p: string) => stat(p).then(() => true, () => false);

/** Gathers Linux facts through the injectable runner. Every probe is best effort: failures leave the fact unknown. */
export async function linuxHostFacts(runner: Runner, docker: DockerStatus, opts: FactOptions = {}): Promise<LinuxHostFacts> {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? fileExists;
  const facts = unknownLinuxFacts();
  facts.uid = opts.uid !== undefined ? opts.uid : (typeof process.getuid === 'function' ? process.getuid() : null);
  facts.dockerHost = env.DOCKER_HOST || null;
  const safe = async (cmd: string, args: string[]) => {
    try { return await runner(cmd, args, { allowFailure: true, timeoutMs: 15_000 }); } catch { return null; }
  };
  if (docker.daemon) {
    const r = await safe('docker', ['info', '--format', '{{json .SecurityOptions}}']);
    if (r?.code === 0) {
      try {
        const v = JSON.parse(r.stdout.trim()) as unknown;
        if (Array.isArray(v) && v.every((s) => typeof s === 'string')) facts.securityOptions = v as string[];
      } catch { /* unknown */ }
    }
  }
  if (facts.uid !== null) {
    // Rootless from `docker info` when known, else the env/context heuristic (same as compose generation).
    const rootless = facts.securityOptions ? isRootless(facts) : undefined;
    try {
      facts.secretsAccess = probeSecretsAccess({ platform: 'linux', uid: facts.uid, env, ...(rootless !== undefined ? { rootless } : {}),
        ...(opts.readFile ? { readFile: opts.readFile } : {}) });
    } catch { /* unknown */ }
  }
  const se = await safe('getenforce', []);
  const mode = se?.code === 0 ? se.stdout.trim().toLowerCase() : '';
  if (mode === 'enforcing' || mode === 'permissive' || mode === 'disabled') facts.selinux = mode;
  if (env.XDG_RUNTIME_DIR) {
    const sock = join(env.XDG_RUNTIME_DIR, 'docker.sock');
    if (await exists(sock).catch(() => false)) facts.rootlessSocket = sock;
  }
  if (!docker.compose) {
    const v1 = await safe('docker-compose', ['--version']);
    if (v1?.code === 0 && v1.stdout.trim()) facts.composeV1 = v1.stdout.trim().split('\n')[0]!;
  }
  return facts;
}

const hasOption = (facts: LinuxHostFacts, name: string) =>
  !!facts.securityOptions?.some((o) => o.split(',').includes(`name=${name}`));
export const isRootless = (facts: LinuxHostFacts) => hasOption(facts, 'rootless');

const ROOTLESS_DOCS = 'https://docs.docker.com/engine/security/rootless/';
const INSTALL_DOCS = 'https://docs.docker.com/engine/install/';

/** Fix for an unreachable daemon. macOS keeps the Docker Desktop hint. */
export function daemonHint(platform: NodeJS.Platform, status: DockerStatus, facts: LinuxHostFacts = unknownLinuxFacts()): string {
  if (platform !== 'linux') return 'Start Docker Desktop.';
  const err = status.error ?? '';
  if (/ENOENT|command not found|not found: docker/i.test(err)) {
    return `Install Docker Engine (${INSTALL_DOCS}; Ubuntu/Debian: Docker's apt repository, Fedora/RHEL: Docker's dnf repository), then rerun \`minions doctor\`.`;
  }
  if (/permission denied/i.test(err)) {
    return 'Your user may not open the Docker socket. Either add it to the docker group (this grants root-equivalent access): '
      + '`sudo usermod -aG docker "$USER"`, then log out and back in (or run `newgrp docker`); '
      + `or use rootless Docker (${ROOTLESS_DOCS}) with \`export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock\`.`;
  }
  if (facts.rootlessSocket && !facts.dockerHost) {
    return `A rootless Docker socket exists at ${facts.rootlessSocket} but DOCKER_HOST is not set: \`export DOCKER_HOST=unix://${facts.rootlessSocket}\` (or \`docker context use rootless\`).`;
  }
  if (facts.dockerHost && /\/run\/user\/\d+\//.test(facts.dockerHost)) {
    return 'Start rootless Docker: `systemctl --user start docker` (start it at boot: `systemctl --user enable docker` and `sudo loginctl enable-linger "$USER"`).';
  }
  return 'Start Docker Engine: `sudo systemctl enable --now docker` (rootless Docker: `systemctl --user start docker`), then check `docker info`.';
}

/** Fix for a missing or too old Compose. macOS keeps the Docker Desktop hint. */
export function composeHint(platform: NodeJS.Platform, status: DockerStatus, facts: LinuxHostFacts = unknownLinuxFacts()): string {
  if (platform !== 'linux') return 'Install Docker Compose v2 or newer (bundled with Docker Desktop).';
  const install = 'Install the Compose v2 plugin: `sudo apt-get install docker-compose-plugin` (Ubuntu/Debian with Docker\'s apt repository; '
    + 'Ubuntu\'s own docker.io packages: `sudo apt-get install docker-compose-v2`) or `sudo dnf install docker-compose-plugin` (Fedora/RHEL with Docker\'s repository).';
  if (facts.composeV1) return `Only the legacy Compose v1 is installed (${facts.composeV1}); minions runs \`docker compose\` (v2). ${install}`;
  if (status.composeVersion) return `Compose ${status.composeVersion} is too old (v2 or newer is required). ${install}`;
  return install;
}

export interface LinuxCheck { name: string; status: 'ok' | 'warn'; detail: string; hint?: string }

/**
 * Linux-only checks once the daemon is reachable: rootless mode, host uid vs container uid (bind-mount
 * ownership of the secrets directory), and SELinux labeling of the read-only bind mounts. A fact that
 * could not be probed produces no check (no guesses).
 */
export function linuxDockerChecks(facts: LinuxHostFacts, root: string = hostRoot()): LinuxCheck[] {
  const out: LinuxCheck[] = [];
  const rootless = isRootless(facts);
  if (facts.securityOptions) {
    if (rootless) {
      out.push({ name: 'docker.rootless', status: 'warn',
        detail: `rootless Docker: container uid ${CONTAINER_UID} maps to a subordinate host uid, so it cannot read the 0600 secret files (GitHub/Telegram tokens, Claude key) you own in the mounted secrets directory`,
        hint: 'Not supported yet for host-provisioned secrets. Use rootful Docker Engine (docker group) for projects with `minions auth github|telegram` or a host-provisioned Claude key; an interactive `/login` inside the container still works.' });
    } else {
      out.push({ name: 'docker.rootless', status: 'ok', detail: 'rootful Docker Engine' });
    }
  }
  if (!rootless && facts.securityOptions && facts.uid !== null) {
    if (facts.uid === CONTAINER_UID) {
      out.push({ name: 'docker.uid', status: 'ok', detail: `host uid ${facts.uid} matches the container user (uid ${CONTAINER_UID}); mounted secret files are readable without changing their owner` });
    } else if (facts.secretsAccess?.mode === 'group') {
      const a = facts.secretsAccess;
      out.push({ name: 'docker.uid', status: 'ok',
        detail: `host uid ${facts.uid} differs from the container user (uid ${CONTAINER_UID}); your primary group ${a.group} (gid ${a.gid}) is a private user group, so the secrets directory (0750) and files (0640) carry that group and compose.yaml adds it to the container user (group_add)` });
    } else {
      const why = facts.secretsAccess?.mode === 'unsupported' ? `: ${facts.secretsAccess.reason}` : '';
      out.push({ name: 'docker.uid', status: 'warn',
        detail: `host uid ${facts.uid} differs from the container user (uid ${CONTAINER_UID}) and the secrets cannot be shared through a private group${why}. Docker Engine keeps host ownership on bind mounts, so the 0600 secret files you own are unreadable in the container`,
        hint: `Host-provisioned secrets (GitHub/Telegram tokens, Claude key) need either a host uid of ${CONTAINER_UID} or a private primary group (same name as your user, no other member; the default for \`useradd\` with USERGROUPS_ENAB on Ubuntu/Fedora). An interactive \`/login\` inside the container still works. minions never chowns the secrets to uid ${CONTAINER_UID} and never grants it ACLs, because on the host that uid may be another user.` });
    }
  }
  if (facts.selinux === 'enforcing') {
    const projects = join(root, 'projects');
    if (hasOption(facts, 'selinux')) {
      out.push({ name: 'docker.selinux', status: 'warn',
        detail: 'SELinux is enforcing and Docker labels containers: the read-only bind mounts (plugin, runtime config, secrets) are denied unless labeled container_file_t',
        hint: `Label the project directories once (persistent): \`sudo semanage fcontext -a -t container_file_t '${projects}(/.*)?' && sudo restorecon -R '${projects}'\`; quick fix until the next relabel: \`sudo chcon -R -t container_file_t '${projects}'\`.` });
    } else {
      out.push({ name: 'docker.selinux', status: 'ok', detail: 'SELinux is enforcing, but Docker does not label containers (selinux-enabled off), so bind mounts need no relabeling' });
    }
  }
  return out;
}
