// Types for scripts/prepare.mjs (imported by test/install.test.ts).
export declare const BUILD_DEPS: string[];
export declare function missingBuildDeps(dir?: string): string[];
export declare function localNpmEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function inGitDepPrepare(env?: NodeJS.ProcessEnv, dir?: string): boolean;
export declare function strayGlobalLink(env?: NodeJS.ProcessEnv, dir?: string, platform?: NodeJS.Platform): string | null;
