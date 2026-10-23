// Types for scripts/source-fingerprint.mjs (bundled into the CLI and used by esbuild.config.mjs).
export declare const FINGERPRINT_DIRS: string[];
export declare const FINGERPRINT_FILES: string[];
export declare function sourceFingerprint(root: string): string | null;
export declare const MAX_FINGERPRINT_DEPTH: number;
export declare const MAX_FINGERPRINT_FILES: number;
