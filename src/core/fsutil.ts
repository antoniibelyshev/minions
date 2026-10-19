import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { z } from 'zod';
import { MinionsError, invalidConfig, zodIssues } from './errors.js';

export async function ensureDir(dir: string, mode?: number): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
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
