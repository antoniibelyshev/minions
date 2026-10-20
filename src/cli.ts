import { wantsJson } from './core/cli-helpers.js';
import { handleError } from './core/output.js';
import { buildProgram } from './program.js';

buildProgram().parseAsync(process.argv).catch((err) => handleError(err, { json: wantsJson() }));
