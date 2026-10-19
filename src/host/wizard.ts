// Init wizard (spec §7). Questions are prefilled from the profile, an existing config, and discovery.
// Questions whose answer cannot change v0.1 behaviour are shown as information only, with the
// deferred options marked "(not available in v0.1)". Never asks for secrets.
import { createInterface } from 'node:readline/promises';
import { profileDefaults } from '../config/profiles.js';
import { validateConfig } from '../config/resolve.js';
import { PROFILES, type MinionsConfig, type Profile } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { readJson } from '../core/fsutil.js';
import { VERSION } from '../core/version.js';
import type { Discovery } from './discovery.js';

export interface WizardIO {
  ask(question: string, defaultValue: string): Promise<string>;
  info(line: string): void;
  close?(): void;
}

/** Interactive prompts on stderr (stdout stays clean for --json). */
export function readlineIO(): WizardIO {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return {
    async ask(question, def) {
      const a = (await rl.question(`${question}${def ? ` [${def}]` : ''}: `)).trim();
      return a || def;
    },
    info: (line) => process.stderr.write(line + '\n'),
    close: () => rl.close(),
  };
}

export interface WizardInput {
  discovery: Discovery;
  projectId: string;
  profile?: Profile;
  visibility?: 'shared' | 'private';
  /** Config from a previous install (rerun): its values become the defaults. */
  existing?: MinionsConfig;
  /** --config <file>: validated config, no questions. */
  configFile?: string;
  /** --yes: accept defaults. */
  yes: boolean;
  io?: WizardIO;
}

export interface WizardResult { config: MinionsConfig; notes: string[]; asked: string[] }

const NA = '(not available in v0.1)';

export function parsePorts(s: string): { host: number; container: number }[] {
  const t = s.trim();
  if (!t || t === 'none') return [];
  return t.split(',').map((part) => {
    const m = /^\s*(\d{1,5})(?::(\d{1,5}))?\s*$/.exec(part);
    const host = Number(m?.[1]), container = Number(m?.[2] ?? m?.[1]);
    if (!m || !(host >= 1 && host <= 65535) || !(container >= 1 && container <= 65535)) {
      throw new Error(`invalid port mapping "${part.trim()}" (use host:container, e.g. 3000:3000)`);
    }
    return { host, container };
  });
}
const fmtPorts = (p: { host: number; container: number }[]) => (p.length ? p.map((x) => `${x.host}:${x.container}`).join(',') : 'none');

async function askValid<T>(io: WizardIO, q: string, def: string, parse: (s: string) => T): Promise<T> {
  for (let i = 0; ; i++) {
    const a = await io.ask(q, def);
    try { return parse(a); } catch (e) {
      if (i >= 2) throw new MinionsError('INVALID_CONFIG', `${q}: ${(e as Error).message}`);
      io.info(`  ${(e as Error).message}`);
    }
  }
}

const choice = <T extends string>(opts: readonly T[]) => (s: string): T => {
  const v = s.trim();
  const byNum = /^\d+$/.test(v) ? opts[Number(v) - 1] : undefined;
  const hit = byNum ?? opts.find((o) => o === v);
  if (!hit) throw new Error(`choose one of: ${opts.join(', ')}`);
  return hit;
};
const yesNo = (s: string) => { if (/^y(es)?$/i.test(s)) return true; if (/^no?$/i.test(s)) return false; throw new Error('answer y or n'); };
const posNum = (int: boolean, min: number) => (s: string) => {
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new Error(`enter a ${int ? 'whole ' : ''}number >= ${min}`);
  return n;
};
const nonEmpty = (s: string) => { if (!s.trim()) throw new Error('required'); return s.trim(); };

function baseConfig(input: WizardInput, profile: Profile): { config: MinionsConfig; notes: string[] } {
  const d = input.discovery;
  if (input.existing && input.existing.profile === profile) {
    return { config: { ...structuredClone(input.existing), projectId: input.projectId, packageVersion: VERSION }, notes: [] };
  }
  const r = profileDefaults(profile, {
    hasGitHub: d.git.hasGitHub, baseBranch: d.git.baseBranch,
    identity: { name: d.git.userName ?? '', email: d.git.userEmail ?? '' },
    projectId: input.projectId, packageVersion: VERSION,
  });
  r.config.verification.commands = [...d.verificationCommands];
  return r;
}

export async function runWizard(input: WizardInput): Promise<WizardResult> {
  const d = input.discovery;
  const asked: string[] = [];
  if (input.configFile) {
    const raw = await readJson<Record<string, unknown>>(input.configFile);
    const cfg = validateConfig({ ...raw, projectId: input.projectId, packageVersion: VERSION }, input.configFile);
    if (input.visibility) cfg.visibility = input.visibility;
    return { config: validateConfig(cfg, input.configFile), notes: [`configuration from ${input.configFile}`], asked };
  }

  const interactive = !input.yes;
  if (interactive && !input.io) throw new MinionsError('INTERNAL', 'wizard needs an IO implementation');
  const io = input.io!;
  const ask = async <T>(id: string, q: string, def: string, parse: (s: string) => T): Promise<T> => {
    asked.push(id);
    return askValid(io, q, def, parse);
  };

  // 1. Starting profile.
  let profile: Profile = input.profile ?? input.existing?.profile ?? 'project-owner';
  if (interactive && !input.profile) {
    io.info('Profiles: 1) project-owner  2) personal-work  3) supervised');
    profile = await ask('profile', 'Starting profile', profile, choice(PROFILES));
  }
  const { config: cfg, notes } = baseConfig(input, profile);

  // 2. Visibility.
  if (input.visibility) cfg.visibility = input.visibility;
  else if (interactive) {
    io.info('Installation: shared writes .minions/config.json + README into the repo; private writes nothing into the repo.');
    cfg.visibility = await ask('visibility', 'Installation visibility (shared/private)', cfg.visibility, choice(['shared', 'private'] as const));
  }

  if (interactive) {
    // 3. Backlog backend and ownership — single supported option in v0.1.
    io.info(`Backlog: Backlog.md inside the container (ownership: ${cfg.backlog.ownership}). GitHub Issues ${NA}.`);
    // 4. Intake and authorized scope.
    cfg.intake.startReady = await ask('intake.startReady',
      'Start ready tasks automatically? (n = only tasks labelled minions:authorized)', cfg.intake.startReady ? 'y' : 'n', yesNo);
    // 5. Publication and merge authority.
    io.info(`Delivery: local commits on agent/<slug> branches, fetched with \`minions export\`. Branch push, pull requests, auto-merge ${NA}.`);
    // 6. Communication.
    io.info(`Communication: terminal. Telegram ${NA}.`);
    // 7. Credentials — none requested here.
    io.info('Credentials: log in to Claude inside the container (/login) on first `minions start`; host login is not reused.');
    io.info(`GitHub credential provisioning ${NA}. minions never asks for secrets in this wizard.`);
  }
  if (!cfg.git.identity.name || !cfg.git.identity.email) {
    if (!interactive) {
      throw new MinionsError('PRECONDITION', 'Git identity (user.name / user.email) is not configured for this repository.',
        'Run `git config user.name "…"` and `git config user.email "…"`, or run init interactively.');
    }
    cfg.git.identity.name = await ask('git.identity.name', 'Commit author name for agent commits', cfg.git.identity.name, nonEmpty);
    cfg.git.identity.email = await ask('git.identity.email', 'Commit author email for agent commits', cfg.git.identity.email, nonEmpty);
  }

  if (interactive) {
    // Verification commands (inferred from package.json scripts, never executed on the host).
    const v = await ask('verification.commands', "Verification commands run inside the container (separate with ';', 'none' for none)",
      cfg.verification.commands.join('; ') || 'none', (s) => (s.trim() === 'none' ? [] : s.split(';').map((x) => x.trim()).filter(Boolean)));
    cfg.verification.commands = v;
    // 8. Container resources and preview ports.
    io.info(`Container: image minions-runtime:${VERSION}${d.dockerfile ? ' (the repository Dockerfile is not built)' : ''}; host has ${d.host.cpus} CPUs, ${d.host.memoryMiB} MiB RAM.`);
    cfg.container.cpus = await ask('container.cpus', 'Container CPUs', String(cfg.container.cpus), posNum(false, 0.5));
    cfg.container.memoryMiB = await ask('container.memoryMiB', 'Container memory (MiB)', String(cfg.container.memoryMiB), posNum(true, 512));
    cfg.container.publishPorts = await ask('container.publishPorts', 'Preview ports to publish on 127.0.0.1 (host:container, comma separated)',
      fmtPorts(cfg.container.publishPorts), parsePorts);
  }
  if (cfg.container.cpus > d.host.cpus) notes.push(`container.cpus ${cfg.container.cpus} exceeds host CPUs (${d.host.cpus}).`);
  if (cfg.container.memoryMiB > d.host.memoryMiB) notes.push(`container.memoryMiB ${cfg.container.memoryMiB} exceeds host memory (${d.host.memoryMiB} MiB).`);
  return { config: validateConfig(cfg, 'wizard answers'), notes, asked };
}
