// Runtime selection value (host-only setting; see src/host/runtime.ts). Kept dependency-free so the
// project.json / defaults.json schemas can import it without cycles.
import { z } from 'zod';

export const RUNTIMES = ['docker', 'host'] as const;
export const RuntimeKindSchema = z.enum(RUNTIMES);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

/** Absent = docker (the default and the only isolated runtime). */
export const runtimeOf = (p: { runtime?: RuntimeKind }): RuntimeKind => p.runtime ?? 'docker';
