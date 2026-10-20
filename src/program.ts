import { Command } from 'commander';
import { VERSION } from './core/version.js';
import { register as registerHost } from './host/commands.js';
import { register as registerRuntime } from './runtime/commands.js';
import { register as registerBacklog } from './backlog/commands.js';
import { applySurface } from './surface.js';

/** Builds the root program with every command registered and the user-facing surface applied. */
export function buildProgram(): Command {
  const program = new Command('minions')
    .description('Run a containerized Claude Code agent team on your project')
    .version(VERSION, '-v, --version')
    .option('--json', 'machine-readable output: {"ok":true,"data":...} or {"ok":false,"error":...}')
    .showHelpAfterError();
  registerHost(program);
  registerRuntime(program);
  registerBacklog(program);
  applySurface(program);
  return program;
}
