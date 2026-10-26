// The production adapter registry of `minions work run`. Codex is registered (agent-runtimes child task 4, gate plan
// first); Junie follows with child task 5. A harness without an entry makes `work run` refuse with PRECONDITION. The
// test-only `fake` adapter (adapter.ts) is never registered here.
import type { ProcessAdapter } from './adapter.js';
import { codexAdapter } from './codex.js';

export const PROCESS_ADAPTERS: Readonly<Record<string, ProcessAdapter>> = Object.freeze({ codex: codexAdapter() });
