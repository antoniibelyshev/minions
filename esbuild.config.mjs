// Bundles src/cli.ts into a single dependency-free dist/cli.js and regenerates schema/config.schema.json.
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { readFileSync, realpathSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceFingerprint } from './scripts/source-fingerprint.mjs';

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

/**
 * The commit a source build is made from (null outside a git checkout), and whether the tree had changes. The host
 * manager's dev-only rebuild-cli plan shows `git log <commit>..HEAD` from it (docs/design/host-manager.md, task-53.7).
 */
function buildCommit() {
  const dir = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
  const git = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  try {
    // Only this package's own checkout counts (not a repository it happens to sit in).
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== dir) return { commit: null, dirty: null };
    const commit = git('rev-parse', '--verify', 'HEAD^{commit}');
    return /^[0-9a-f]{40}$/.test(commit) ? { commit, dirty: git('status', '--porcelain').length > 0 } : { commit: null, dirty: null };
  } catch { return { commit: null, dirty: null }; }
}

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
  // Build stamp read by `minions upgrade` to tell whether the installed CLI matches a checkout.
  // MINIONS_BUILD_KIND=packed is set by install.sh (and by the upgrade's own reinstall) for a packed
  // tarball install; any other build (git-URL prepare, plain `npm run build`) records 'source'.
  writeFileSync('dist/build.json', JSON.stringify({
    version: pkg.version,
    source: sourceFingerprint(fileURLToPath(new URL('.', import.meta.url))),
    kind: process.env.MINIONS_BUILD_KIND === 'packed' ? 'packed' : 'source',
    ...buildCommit(),
  }) + '\n');
}
await generateSchema();
