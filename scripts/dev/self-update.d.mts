// Types for scripts/dev/self-update.mjs (the host-only dev tool; imported only by its tests).
export interface RunOpts { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }
export interface RunResult { code: number; timedOut: boolean; abnormal: boolean; why: string; stdout: string; stderr: string }
export interface Seams { run: (cmd: string, args: string[], opts?: RunOpts) => Promise<RunResult>; psStart: (pid: number) => string }
export declare function setSeams(over: Partial<Seams>): () => void;
export interface MainIo { out?: (text: string) => void; err?: (text: string) => void; onStop?: (stop: (signal: string) => void) => void }
export declare function main(argv: string[], io?: MainIo): Promise<number>;
export declare function hostRoot(env?: NodeJS.ProcessEnv, platform?: string, home?: string): string;
export declare const isMinionsCheckout: (dir: string) => boolean;
export declare function pickRequest<T extends { id?: unknown; createdAt?: unknown }>(requests: T[], baseBranch: string): T | null;
export declare function procStart(pid: number): string | null;
export declare const paths: (home: string) => { dir: string; lock: string; log: string; state: string };
export declare function prevImageTag(tag: string): string;
export declare function globToRegExp(glob: string): RegExp;
export declare const matchesAny: (path: string, globs: string[]) => boolean;
export declare function cliBackups(home: string): { name: string; file: string; version: string; stamp: string }[];
export declare const NOTICE_MAX: number;
export declare function noticeText(apply: Record<string, unknown>, files: { log: string }): string;
