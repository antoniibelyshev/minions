// `npm prepare` hook: builds dist/ so that `npm install -g github:antoniibelyshev/minions` (a git
// install) yields a working `minions` binary.
//
// npm prepares a git dependency by cloning it and running `npm install` (with devDependencies) in
// the clone. During `npm install -g`, that nested install inherits the outer global/prefix settings
// through npm_config_* environment variables, so it installs nothing into the clone (the build tools
// are missing) and links the temporary clone into the global prefix instead. This hook repairs both:
// it installs the locked devDependencies locally when they are missing, builds, and removes the
// stray global link so the outer install can write a real directory. Both repairs happen only
// during that git-dependency preparation (see inGitDepPrepare); anywhere else this hook just builds.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Build-time packages that must resolve from the package root before esbuild can run. */
export const BUILD_DEPS = ['esbuild', 'zod', 'commander'];

export function missingBuildDeps(dir = root) {
  const req = createRequire(join(dir, 'package.json'));
  return BUILD_DEPS.filter((name) => {
    for (const id of [`${name}/package.json`, name]) {
      try { req.resolve(id); return false; } catch { /* try the next form */ }
    }
    return true;
  });
}

/** Environment for a nested npm: no global/prefix/omit settings inherited from an outer `npm install -g`. */
export function localNpmEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^npm_config_(global|prefix|location|omit|production|only)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * True only inside npm's preparation of a git dependency: pacote (npm/node_modules/pacote/lib/git.js)
 * clones into `<cache>/_cacache/tmp/git-clone<random>` and runs the nested `npm install` there with
 * `_PACOTE_NO_PREPARE_` set. Both signals are required, so a plain `npm install` or
 * `npm install -g .` from a checkout is never treated as one.
 */
export function inGitDepPrepare(env = process.env, dir = root) {
  if (!env._PACOTE_NO_PREPARE_) return false;
  try {
    return /^git-clone/.test(basename(realpathSync(dir)));
  } catch {
    return false;
  }
}

/**
 * The nested global `npm install` links the temporary clone into the global prefix
 * (<prefix>/lib/node_modules/minions -> clone). The outer install would then extract the packed
 * package through that link into the clone, which npm deletes afterwards, leaving a dangling
 * install. Returns that link when it exists and points at `dir`, else null.
 */
export function strayGlobalLink(env = process.env, dir = root, platform = process.platform) {
  if (!inGitDepPrepare(env, dir)) return null;
  if (env.npm_config_global !== 'true' || !env.npm_config_prefix) return null;
  const prefix = resolve(env.npm_config_prefix);
  const link = platform === 'win32' ? join(prefix, 'node_modules', 'minions') : join(prefix, 'lib', 'node_modules', 'minions');
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    return realpathSync(link) === realpathSync(dir) ? link : null;
  } catch {
    return null;
  }
}

function npm(args) {
  const execPath = process.env.npm_execpath;
  const [cmd, argv] = execPath && /\.c?js$/.test(execPath) ? [process.execPath, [execPath, ...args]] : ['npm', args];
  const r = spawnSync(cmd, argv, { cwd: root, env: localNpmEnv(), stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' });
  if (r.status !== 0) {
    console.error(`minions prepare: \`npm ${args.join(' ')}\` failed (exit ${r.status ?? r.signal}).`);
    process.exit(r.status || 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gitDep = inGitDepPrepare();
  const missing = missingBuildDeps();
  if (missing.length > 0 && !gitDep) {
    // e.g. `npm ci --omit=dev` in a checkout: never install devDependencies behind the user's back.
    if (existsSync(join(root, 'dist', 'cli.js'))) {
      console.error(`minions prepare: build dependencies not installed (${missing.join(', ')}); keeping the existing dist/.`);
      process.exit(0);
    }
    console.error(`minions prepare: build dependencies not installed (${missing.join(', ')}); run \`npm install\` and \`npm run build\`.`);
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`minions prepare: build dependencies not installed (${missing.join(', ')}); installing them locally.`);
    const lock = existsSync(join(root, 'package-lock.json'));
    npm([lock ? 'ci' : 'install', '--global=false', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...(lock ? [] : ['--no-save'])]);
  }
  npm(['run', 'build']);
  const link = gitDep ? strayGlobalLink() : null;
  if (link) {
    // The outer install created this directory and is about to extract into it; leave it empty and real.
    unlinkSync(link);
    mkdirSync(link);
  }
}
