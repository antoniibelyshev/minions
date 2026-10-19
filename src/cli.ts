import { Command } from 'commander';
import { wantsJson } from './core/cli-helpers.js';
import { handleError } from './core/output.js';
import { VERSION } from './core/version.js';
import { register as registerHost } from './host/commands.js';
import { register as registerRuntime } from './runtime/commands.js';
import { register as registerBacklog } from './backlog/commands.js';

export function buildProgram(): Command {
  const program = new Command('minions')
    .description('Run a containerized Claude Code agent team on your project')
    .version(VERSION, '-v, --version')
    .option('--json', 'machine-readable output: {"ok":true,"data":...} or {"ok":false,"error":...}')
    .showHelpAfterError();
  registerHost(program);
  registerRuntime(program);
  registerBacklog(program);
  return program;
}

buildProgram().parseAsync(process.argv).catch((err) => handleError(err, { json: wantsJson() }));
