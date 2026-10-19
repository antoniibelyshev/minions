import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { z } from 'zod';
import { MinionsError, invalidConfig, zodIssues } from './errors.js';

export async function ensureDir(dir: string, mode?: number): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
}

/**
 * Ensures `dir` is a real directory (not a symlink) owned by this user, creating it 0700. A symlink or
 * non-directory at that path is refused (PRECONDITION), never followed.
 */
export async function ensureRealDir(dir: string, mode = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
  const st = await lstat(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) {
    throw new MinionsError('PRECONDITION', `${dir} is not a directory owned by you (symlink or foreign file); refusing to use it.`, 'Remove it and rerun.');
  }
}

/**
 * Copies a regular file without following symlinks at either end: the source is opened with
 * O_NOFOLLOW and checked with fstat on the open descriptor (no lstat/copy race), the destination is
 * created exclusively (O_EXCL | O_NOFOLLOW, 0600 by default). PRECONDITION for anything but a regular file.
 */
export async function copyRegularFileNoFollow(src: string, dst: string, mode = 0o600): Promise<void> {
  const notRegular = () => new MinionsError('PRECONDITION', `${src} is not a regular file; refusing to copy it.`);
  let input;
  try { input = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw notRegular();
    throw e;
  }
  try {
    if (!(await input.stat()).isFile()) throw notRegular();
    const output = await open(dst, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (;;) {
        const { bytesRead } = await input.read(buf, 0, buf.length, null);
        if (!bytesRead) break;
        let off = 0;
        while (off < bytesRead) off += (await output.write(buf, off, bytesRead - off)).bytesWritten;
      }
      await output.sync();
    } catch (e) {
      await output.close().catch(() => undefined);
      await rm(dst, { force: true });
      throw e;
    }
    await output.close();
  } finally { await input.close(); }
}

/** Writes via a temp file in the same directory, then renames over the target. */
export async function atomicWrite(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, data, { mode: opts.mode ?? 0o644, flush: true });
    if (opts.mode !== undefined) await chmod(tmp, opts.mode); // umask may have narrowed it
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export const writeJson = (path: string, data: unknown, opts?: { mode?: number }) =>
  atomicWrite(path, JSON.stringify(data, null, 2) + '\n', opts);

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

export async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Reads JSON; NOT_FOUND if missing, INVALID_CONFIG on bad JSON or schema mismatch (dotted paths listed). */
export async function readJson<T = unknown>(path: string, schema?: z.ZodType<T>): Promise<T> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new MinionsError('NOT_FOUND', `File not found: ${path}`);
    throw e;
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    throw invalidConfig([{ path: '', message: `not valid JSON (${(e as Error).message})` }], path);
  }
  return schema ? parseWith(schema, raw, path) : (raw as T);
}

export function parseWith<T>(schema: z.ZodType<T>, raw: unknown, source?: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw invalidConfig(zodIssues(r.error.issues), source);
  return r.data;
}

/** Like readJson but returns undefined when the file doesn't exist. */
export async function readJsonIfExists<T = unknown>(path: string, schema?: z.ZodType<T>): Promise<T | undefined> {
  try { return await readJson(path, schema); } catch (e) {
    if (e instanceof MinionsError && e.code === 'NOT_FOUND') return undefined;
    throw e;
  }
}
