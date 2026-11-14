// `minions secrets ...` (docs/design/autonomy.md Decision 4): owner secrets for the dispatcher's workers.
//
// - host only: `set <NAME> [--role <r>]...` (value from a hidden prompt or piped stdin, never argv), `grant` / `revoke
//   <NAME> --role <r>...` and `remove <NAME>`. Grants take effect at the next worker launch; nothing restarts.
// - both: `list` (names, grants, sizes and set times; never values). In the runtime it reads the manifest.
import { Option, type Command } from 'commander';
import { action, globalOpts, requireMode, runtimeMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { runtimePaths } from '../runtime/paths.js';
import { listGrants, MAX_SECRET_BYTES, readManifest, secretManifestPath } from '../runtime/secrets.js';
import { changeGrant, ownerSecrets, removeOwnerSecret, setOwnerSecret, strayValues } from './owner-secrets.js';
import { projectForPath } from './registry.js';
import { readSecret } from './wizard.js';

const collect = (v: string, prev: string[] = []) => [...prev, v];
const roleOption = () => new Option('--role <role>', 'a worker role that receives it in its env (repeatable)').argParser(collect);

async function readValue(name: string, stdin: boolean | undefined): Promise<string> {
  if (!stdin) {
    if (!process.stdin.isTTY) throw new MinionsError('PRECONDITION', 'No terminal to prompt for the value.', `Pipe it: \`minions secrets set ${name} --stdin < file\`.`);
    return readSecret(`${name} (input hidden): `);
  }
  if (process.stdin.isTTY) throw new MinionsError('PRECONDITION', '--stdin expects a pipe, not a terminal.', 'Omit --stdin to be prompted without echo.');
  let data = '';
  for await (const chunk of process.stdin) { data += String(chunk); if (data.length > MAX_SECRET_BYTES + 2) break; }
  return data;
}

const formatList = (xs: ReturnType<typeof listGrants>) => xs.map((x) => `${x.name}  ${x.roles.length ? `roles: ${x.roles.join(', ')}` : 'not granted'}  ${x.bytes} bytes  set ${x.setAt}`).join('\n') || 'No secrets stored.';

export function registerSecrets(program: Command): void {
  const secrets = program.command('secrets').description('Owner secrets for the workers: set on the host only (never by an agent), granted per worker role; the coordinator sees names and grants, never values');

  secrets.command('set <name>').description('Store or replace a secret (hidden prompt, or --stdin); --role grants it')
    .option('--stdin', 'read the value from piped stdin (all of it; multi-line values are kept)')
    .addOption(roleOption())
    .action(action(async (name: string, o: { stdin?: boolean; role?: string[] }, cmd: Command) => {
      requireMode('host');
      const { projectId } = await projectForPath(process.cwd());
      const r = await setOwnerSecret(projectId, name, await readValue(name, o.stdin), { roles: o.role ?? [] });
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `${x.replaced ? 'Replaced' : 'Stored'} ${x.name} (${x.bytes} bytes). ${x.roles.length
        ? `Granted to ${x.roles.join(', ')}: their next worker gets it.` : `Not granted yet: \`minions secrets grant ${x.name} --role <role>\`.`}` });
    }));

  for (const op of ['grant', 'revoke'] as const) {
    secrets.command(`${op} <name>`).description(op === 'grant' ? 'Give a stored secret to worker roles' : 'Take a secret away from worker roles')
      .addOption(roleOption().makeOptionMandatory())
      .action(action(async (name: string, o: { role: string[] }, cmd: Command) => {
        requireMode('host');
        const { projectId } = await projectForPath(process.cwd());
        const r = await changeGrant(projectId, name, o.role, op);
        emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `${x.name}: ${x.roles.length ? `granted to ${x.roles.join(', ')}` : 'granted to no role'}.` });
      }));
  }

  secrets.command('remove <name>').description('Delete a stored secret and its grants')
    .action(action(async (name: string, _o: unknown, cmd: Command) => {
      requireMode('host');
      const { projectId } = await projectForPath(process.cwd());
      const r = await removeOwnerSecret(projectId, name);
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => (x.removed ? `Removed ${x.name}.` : `${x.name} was not stored.`) });
    }));

  secrets.command('list').description('Secret names, grants, sizes and set times (never values)')
    .action(action(async (_o: unknown, cmd: Command) => {
      const json = globalOpts(cmd).json;
      if (runtimeMode() !== 'host') {
        const r = listGrants(readManifest(secretManifestPath(runtimePaths().configJson)));
        emit(r, { json, human: formatList });
        return;
      }
      const { projectId } = await projectForPath(process.cwd());
      const r = ownerSecrets(projectId);
      const stray = await strayValues(projectId);
      emit(r, { json, human: (xs: typeof r) => [formatList(xs), ...(stray.length ? [`warning: value files without a manifest entry: ${stray.join(', ')} (\`minions secrets remove <name>\`)`] : [])].join('\n') });
    }));
}
