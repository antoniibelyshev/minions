import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configJsonSchema } from './schema.js';

/** Invoked by esbuild.config.mjs (`npm run schema` / `npm run build`). */
export function writeConfigSchema(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(configJsonSchema(), null, 2) + '\n');
}
