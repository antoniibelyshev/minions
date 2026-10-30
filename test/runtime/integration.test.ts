// Local integration engine (task-82.1, docs/design/local-auto-integration.md phase 1): candidate, sensitive
// diff, revert-of-revert check and landing, on real temp repositories (never the workspace checkout).
import { describe, expect, it } from 'vitest';
import { integrationMessage } from '../../src/runtime/integration.js';
import { gitSync } from './fixtures.js';


describe('integrationCandidate', () => {

  it('rejects control characters in the message (no trailer injection)', () => {
    const head = 'a'.repeat(40);
    expect(() => integrationMessage({ branch: "agent/x'\n\nMinions-Approved-Head: b", taskId: 't', head })).toThrow(/invalid branch/);
    expect(() => integrationMessage({ branch: 'agent/x', taskId: 't', head: 'abc' })).toThrow(/full SHA/);
  });
});
