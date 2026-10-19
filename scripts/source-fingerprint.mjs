// Source fingerprint of a minions checkout: a hash over the files a build and `npm pack` turn into the
// installed package. esbuild.config.mjs stamps it into dist/build.json; `minions upgrade` recomputes it
// on the project checkout to tell whether the installed CLI was built from that source.
// Regular files only: symlinks and other special files are skipped (never followed).
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FINGERPRINT_DIRS = ['src', 'templates', 'docker', 'scripts'];
export const FINGERPRINT_FILES = ['package.json', 'package-lock.json', 'esbuild.config.mjs'];

function walk(root, rel, out) {
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Hex fingerprint (16 chars) of the package source under `root`, or null when root has no package.json. */
export function sourceFingerprint(root) {
  const files = [];
  for (const d of FINGERPRINT_DIRS) walk(root, d, files);
  for (const f of FINGERPRINT_FILES) {
    try { if (lstatSync(join(root, f)).isFile()) files.push(f); } catch { /* absent */ }
  }
  if (!files.includes('package.json')) return null;
  const h = createHash('sha256');
  for (const f of files.sort()) h.update(f).update('\0').update(readFileSync(join(root, f))).update('\0');
  return h.digest('hex').slice(0, 16);
}
