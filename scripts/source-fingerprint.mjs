// Source fingerprint of a minions checkout: a hash over the files a build and `npm pack` turn into the
// installed package. esbuild.config.mjs stamps it into dist/build.json; `minions upgrade` recomputes it
// on the project checkout to tell whether the installed CLI was built from that source.
// Regular files only: symlinks and other special files are skipped (never followed), including a
// symlinked top-level directory (a symlinked src/ must not pull files from outside the checkout).
// Traversal is bounded (depth and file count) and walks entries in sorted order, so a capped walk is
// still deterministic.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FINGERPRINT_DIRS = ['src', 'templates', 'docker', 'scripts'];
export const FINGERPRINT_FILES = ['package.json', 'package-lock.json', 'esbuild.config.mjs'];
/** Directory depth below a fingerprint dir that is still walked. */
export const MAX_FINGERPRINT_DEPTH = 32;
/** Files hashed from the fingerprint dirs at most (the walk stops there). */
export const MAX_FINGERPRINT_FILES = 20_000;

const isRealDir = (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };

function walk(root, rel, depth, out) {
  if (depth > MAX_FINGERPRINT_DEPTH) return;
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (out.length >= MAX_FINGERPRINT_FILES) return;
    const p = `${rel}/${e.name}`;
    // Dirent types are not followed: a symlink is neither isDirectory() nor isFile().
    if (e.isDirectory()) walk(root, p, depth + 1, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Hex fingerprint (16 chars) of the package source under `root`, or null when root has no package.json. */
export function sourceFingerprint(root) {
  const files = [];
  for (const d of FINGERPRINT_DIRS) if (isRealDir(join(root, d))) walk(root, d, 0, files);
  for (const f of FINGERPRINT_FILES) {
    try { if (lstatSync(join(root, f)).isFile()) files.push(f); } catch { /* absent */ }
  }
  if (!files.includes('package.json')) return null;
  const h = createHash('sha256');
  for (const f of files.sort()) h.update(f).update('\0').update(readFileSync(join(root, f))).update('\0');
  return h.digest('hex').slice(0, 16);
}
