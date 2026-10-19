// Bundles src/cli.ts into a single dependency-free dist/cli.js and regenerates schema/config.schema.json.
import { build } from 'esbuild';
import { readFileSync, rmSync, chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['node:*'],
  define: { __MINIONS_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
};

async function generateSchema() {
  const tmp = 'dist/.schema-gen.mjs';
  await build({ ...common, entryPoints: ['src/config/schema-gen.ts'], outfile: tmp });
  try {
    const { writeConfigSchema } = await import(pathToFileURL(tmp).href);
    writeConfigSchema('schema/config.schema.json');
  } finally {
    rmSync(tmp, { force: true });
  }
}

if (!process.argv.includes('--schema-only')) {
  await build({
    ...common,
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    banner: {
      // Shebang plus a require shim for any CJS code paths in bundled deps.
      js: "#!/usr/bin/env node\nimport { createRequire as __minionsCreateRequire } from 'node:module';\nconst require = __minionsCreateRequire(import.meta.url);",
    },
  });
  chmodSync('dist/cli.js', 0o755);
}
await generateSchema();
