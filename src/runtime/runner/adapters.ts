// The production adapter registry of `minions work run`. Empty until the Codex and Junie adapters land
// (agent-runtimes child tasks 4 and 5): until then `work run` refuses every lease with PRECONDITION. The test-only
// `fake` adapter (adapter.ts) is never registered here.
import type { ProcessAdapter } from './adapter.js';

export const PROCESS_ADAPTERS: Readonly<Record<string, ProcessAdapter>> = Object.freeze({});
