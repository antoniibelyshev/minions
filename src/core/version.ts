declare const __MINIONS_VERSION__: string | undefined;
/** Injected at build time by esbuild (and vitest) from package.json. */
export const VERSION: string = typeof __MINIONS_VERSION__ === 'string' ? __MINIONS_VERSION__ : '0.0.0-dev';
