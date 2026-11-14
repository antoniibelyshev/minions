// The host publisher's decisions (docs/design/autonomy.md Decision 17), with a fake bot, fake per-project operations and
// an in-memory state: who may press, what a press is bound to, and what the owner is told. The git side
// (planPublish / publishCommit) is test/host/publish-git.test.ts.
import { describe, expect, it } from 'vitest';
import type { ChangeRequestView } from '../../src/runtime/change-requests.js';
import type { PublishMode, PublishPlan, PublishResult } from '../../src/host/publish.js';
import {
  callbackData, parseCallback, promptText, PublisherCore, type PublisherOps, type PublisherProject, type PublisherState, type StateStore,
} from '../../src/host/publisher.js';
import type { TelegramUpdate } from '../../src/telegram/bot-api.js';

const OWNER = 4242;
const SHA = '1'.repeat(40);
const OTHER = '2'.repeat(40);
const project: PublisherProject = { projectId: '11111111-1111-4111-8111-111111111111', name: 'shop', repoPath: '/repo/shop', baseBranch: 'main' };

const request = (over: Partial<ChangeRequestView> & { sha?: string } = {}): ChangeRequestView => ({
  id: 'cr_0000000a', kind: 'publish', payload: { base: 'main', sha: over.sha ?? SHA, tasks: ['task-1', 'task-2'] }, reason: 'Checkout flow and fixes',
  createdAt: '2026-11-14T10:00:00Z', status: 'proposed', updatedAt: '2026-11-14T10:00:00Z', detail: null, summary: 'publish', ...over,
});
const plan = (over: Partial<PublishPlan> = {}): PublishPlan => ({
  base: 'main', sha: SHA, remote: 'origin', remoteUrl: 'git@github.com:o/shop.git', from: '0'.repeat(40), commits: 3, subjects: ['Add checkout', 'Fix cart'], files: 4, hits: [], refusal: null, ...over,
});

function harness(o: { requests?: ChangeRequestView[] | null; plan?: (sha: string | null) => PublishPlan | null; mode?: () => PublishMode } = {}) {
  let st: PublisherState = { version: 1, prompts: [], handled: [] };
  const state: StateStore = { load: async () => structuredClone(st), save: async (s) => { st = structuredClone(s); } };
  const sent: { text: string; keyboard?: unknown }[] = [];
  const edits: { id: number; text: string }[] = [];
  const answers: string[] = [];
  const marks: [string, string, string][] = [];
  const published: { sha: string; mode: PublishMode }[] = [];
  const prepared: (string | null)[] = [];
  let requests = o.requests === undefined ? [request()] : o.requests;
  let msg = 100;
  const ops: PublisherOps = {
    projects: async () => [project],
    requests: async () => requests,
    mark: async (_p, id, status, detail) => {
      marks.push([id, status, detail]);
      if (requests) requests = requests.map((r) => (r.id === id ? { ...r, status } : r));
    },
    prepare: async (_p, sha) => { prepared.push(sha); const p = o.plan ? o.plan(sha) : plan({ sha: sha ?? SHA }); return { plan: p, tasks: ['task-7'] }; },
    mode: async () => o.mode?.() ?? 'direct',
    publish: async (_p, pl, mode): Promise<PublishResult> => {
      published.push({ sha: pl.sha, mode });
      return { mode, base: 'main', sha: pl.sha, ref: mode === 'direct' ? 'refs/heads/main' : `refs/heads/minions/publish-${pl.sha.slice(0, 12)}`, prUrl: mode === 'direct' ? null : 'https://github.com/o/shop/pull/9',
        checkout: mode === 'direct' ? { action: 'fast-forward', reason: 'ok', base: 'main', from: null, to: pl.sha, applied: true } : null };
    },
  };
  const bot = {
    sendMessage: async (chatId: number, text: string, opt: { keyboard?: unknown } = {}) => { expect(chatId).toBe(OWNER); sent.push({ text, keyboard: opt.keyboard }); return ++msg; },
    editMessageText: async (_c: number, id: number, text: string) => { edits.push({ id, text }); },
    answerCallbackQuery: async (_id: string, text: string) => { answers.push(text); },
  };
  let n = 0;
  const core = new PublisherCore({ bot, ownerId: OWNER, ops, state, nonce: () => (++n).toString(16).padStart(24, '0') });
  return {
    core, sent, edits, answers, marks, published, prepared,
    state: () => st,
    setRequests: (r: ChangeRequestView[] | null) => { requests = r; },
  };
}

let uid = 1;
const press = (data: string, from = OWNER, chat = OWNER): TelegramUpdate => ({ update_id: uid++, callback_query: { id: `cb${uid}`, data, from: { id: from }, message: { message_id: 101, chat: { id: chat } } } });
const message = (text: string, o: { from?: number; chat?: number; type?: string; forwarded?: boolean } = {}): TelegramUpdate =>
  ({ update_id: uid++, message: { message_id: 5, text, from: { id: o.from ?? OWNER }, chat: { id: o.chat ?? OWNER, type: o.type ?? 'private' }, ...(o.forwarded ? { forward_date: 1 } : {}) } });

describe('publisher: asking', () => {
  it('asks the owner once per new request, with the facts from git and the coordinator\'s words quoted', async () => {
    const h = harness();
    await h.core.scan();
    await h.core.scan();
    expect(h.sent).toHaveLength(1);
    const { text, keyboard } = h.sent[0]!;
    expect(text.split('\n')[0]).toBe(`Publish 3 commits (tasks task-1, task-2) to main at ${SHA.slice(0, 7)}?`);
    expect(text).toContain('Coordinator\'s summary: "Checkout flow and fixes"');
    expect(text).toContain(`Commit: ${SHA}`);
    expect(keyboard).toEqual([[{ text: 'Publish', callback_data: callbackData('pub', '1'.padStart(24, '0')) }, { text: 'Not now', callback_data: callbackData('not', '1'.padStart(24, '0')) }]]);
    expect(h.state().prompts).toMatchObject([{ requestId: 'cr_0000000a', sha: SHA, commits: 3, mode: 'direct', status: 'asked' }]);
    expect(h.prepared).toEqual([SHA]);
  });

  it('refuses a request whose range has a secret, tells the owner, and never asks', async () => {
    const h = harness({ plan: () => plan({ hits: [{ kind: 'secret-file', path: '.env', detail: 'x' }], refusal: { code: 'scan', message: 'the outgoing range has 1 finding(s): .env: x' } }) });
    await h.core.scan();
    expect(h.marks).toEqual([['cr_0000000a', 'rejected', 'the outgoing range has 1 finding(s): .env: x']]);
    expect(h.sent.map((s) => s.text)).toEqual([expect.stringMatching(/^shop: not asking about publish request cr_0000000a: the outgoing range has 1 finding/)]);
    expect(h.sent[0]!.keyboard).toBeUndefined();
    await h.core.scan();
    expect(h.marks).toHaveLength(1);
  });

  it('marks a request rejected without a remote (publishing unavailable) and retries a failed fetch later', async () => {
    const none = harness({ plan: () => plan({ refusal: { code: 'no-remote', message: 'publishing is unavailable: the checkout has no git remote "origin"' } }) });
    await none.core.scan();
    expect(none.marks[0]).toEqual(['cr_0000000a', 'rejected', expect.stringMatching(/publishing is unavailable/)]);
    expect(none.sent).toHaveLength(0);
    const flaky = harness({ plan: () => plan({ refusal: { code: 'fetch-failed', message: 'git fetch origin main failed: timeout' } }) });
    await flaky.core.scan();
    expect(flaky.marks).toHaveLength(0);
    expect(flaky.core.lastErrors.get(project.projectId)).toMatch(/fetch origin main failed/);
  });

  it('rejects a request for another base branch or a malformed one', async () => {
    const h = harness({ requests: [request({ payload: { base: 'release', sha: SHA } }), request({ id: 'cr_0000000b', payload: { base: 'main', sha: 'HEAD' } })] });
    await h.core.scan();
    expect(h.marks.map((m) => m[0])).toEqual(['cr_0000000a', 'cr_0000000b']);
    expect(h.sent).toHaveLength(0);
  });

  it('a superseded request loses its buttons', async () => {
    const h = harness();
    await h.core.scan();
    h.setRequests([]);
    await h.core.scan();
    expect(h.edits.at(-1)!.text).toMatch(/was superseded or closed; nothing was pushed/);
    await h.core.handleUpdate(press(callbackData('pub', '1'.padStart(24, '0'))));
    expect(h.answers).toEqual([expect.stringMatching(/expired or was superseded/)]);
    expect(h.published).toEqual([]);
  });
});

describe('publisher: who may press, and what a press publishes', () => {
  const nonce = '1'.padStart(24, '0');

  it('drops presses from anyone but the owner, or outside the owner\'s private chat, without a reply', async () => {
    const h = harness();
    await h.core.scan();
    await h.core.handleUpdate(press(callbackData('pub', nonce), 777));
    await h.core.handleUpdate(press(callbackData('pub', nonce), OWNER, -100123));
    await h.core.handleUpdate(press('pub:not-a-nonce'));
    expect(h.answers).toEqual([]);
    expect(h.published).toEqual([]);
    expect(h.marks).toEqual([]);
  });

  it('publishes exactly the SHA the owner was shown, even if the request row changed after the prompt', async () => {
    const h = harness();
    await h.core.scan();
    // The runtime row is agent-writable: point it at another commit after the prompt went out.
    h.setRequests([request({ sha: OTHER, status: 'proposed' })]);
    await h.core.handleUpdate(press(callbackData('pub', nonce)));
    expect(h.prepared).toEqual([SHA, SHA]);
    expect(h.published).toEqual([{ sha: SHA, mode: 'direct' }]);
    expect(h.marks.map((m) => m[1])).toEqual(['confirmed', 'applied']);
    expect(h.marks[1]![2]).toBe(`pushed ${SHA} to origin/main`);
    expect(h.edits.at(-1)!.text).toMatch(/^shop: published\. pushed .* Your checkout was fast-forwarded/);
    expect(h.state().prompts).toEqual([]);
    expect(h.state().handled).toContain(`${project.projectId}/cr_0000000a`);
  });

  it('binds the mode shown at the prompt: a later config change does not turn a PR into a direct push', async () => {
    let mode: PublishMode = 'pull-request';
    const h = harness({ mode: () => mode });
    await h.core.scan();
    mode = 'direct';
    await h.core.handleUpdate(press(callbackData('pub', nonce)));
    expect(h.published).toEqual([{ sha: SHA, mode: 'pull-request' }]);
    expect(h.marks.at(-1)![2]).toMatch(/pull request https:\/\/github.com\/o\/shop\/pull\/9/);
  });

  it('a second press while publishing does nothing; "Not now" rejects the request', async () => {
    const h = harness();
    await h.core.scan();
    const st = h.state();
    st.prompts[0]!.status = 'publishing';
    await (h.core as unknown as { state: StateStore }).state.save(st);
    await h.core.handleUpdate(press(callbackData('pub', nonce)));
    expect(h.answers).toEqual(['Already being handled.']);
    expect(h.published).toEqual([]);

    const n = harness();
    await n.core.scan();
    await n.core.handleUpdate(press(callbackData('not', nonce)));
    expect(n.marks).toEqual([['cr_0000000a', 'rejected', 'the owner chose "Not now" in Telegram']]);
    expect(n.published).toEqual([]);
    expect(n.edits.at(-1)!.text).toMatch(/not published/);
  });

  it('re-checks at the press: origin moved, so nothing is pushed and the request fails', async () => {
    let calls = 0;
    const h = harness({ plan: (sha) => (++calls === 1 ? plan({ sha: sha! }) : plan({ sha: sha!, refusal: { code: 'diverged', message: 'origin/main moved' } })) });
    await h.core.scan();
    await h.core.handleUpdate(press(callbackData('pub', nonce)));
    expect(h.published).toEqual([]);
    expect(h.marks.map((m) => m[1])).toEqual(['confirmed', 'failed']);
    expect(h.edits.at(-1)!.text).toMatch(/NOT published .*origin\/main moved/);
  });

  it('refuses a press when the request was closed in the meantime', async () => {
    const h = harness();
    await h.core.scan();
    h.setRequests([request({ status: 'expired' })]);
    await h.core.handleUpdate(press(callbackData('pub', nonce)));
    expect(h.published).toEqual([]);
    expect(h.marks).toEqual([['cr_0000000a', 'rejected', 'the request was superseded or closed before the press']]);
  });
});

describe('publisher: commands', () => {
  it('/publish <project> asks about the agents\' current base, owner only, never forwarded', async () => {
    const h = harness({ requests: [] });
    await h.core.handleUpdate(message('/publish shop', { from: 999 }));
    await h.core.handleUpdate(message('/publish shop', { forwarded: true }));
    await h.core.handleUpdate(message('/publish shop', { chat: -5, type: 'group' }));
    expect(h.sent).toEqual([]);
    await h.core.handleUpdate(message('/publish shop'));
    expect(h.prepared).toEqual([null]);
    expect(h.sent[0]!.text.split('\n')[0]).toBe(`Publish 3 commits (task task-7) to main at ${SHA.slice(0, 7)}?`);
    expect(h.state().prompts).toMatchObject([{ requestId: null, sha: SHA }]);
    await h.core.handleUpdate(press(callbackData('pub', '1'.padStart(24, '0'))));
    expect(h.published).toEqual([{ sha: SHA, mode: 'direct' }]);
    expect(h.marks).toEqual([]);
  });

  it('/publish lists the projects; unknown text gets the help; an unknown project is named', async () => {
    const h = harness({ requests: [] });
    await h.core.handleUpdate(message('/publish'));
    await h.core.handleUpdate(message('hello'));
    await h.core.handleUpdate(message('/publish nope'));
    expect(h.sent.map((s) => s.text.split('\n')[0])).toEqual(['Projects:', expect.stringMatching(/^minions publisher/), 'No project named "nope". Send /publish for the list.']);
  });

  it('/publish with nothing new says why', async () => {
    const h = harness({ requests: [], plan: () => plan({ refusal: { code: 'up-to-date', message: `origin/main already contains ${SHA.slice(0, 12)}` } }) });
    await h.core.handleUpdate(message('/publish shop'));
    expect(h.sent[0]!.text).toMatch(/^shop: nothing to publish: origin\/main already contains/);
  });
});

describe('publisher: wire formats', () => {
  it('callback data carries only a nonce', () => {
    expect(parseCallback(callbackData('pub', 'ab'.repeat(12)))).toEqual({ action: 'pub', nonce: 'ab'.repeat(12) });
    for (const bad of ['pub:', 'pub:XYZ', `merge:${'a'.repeat(24)}`, `pub:${'a'.repeat(24)}:${SHA}`, 7, null]) expect(parseCallback(bad)).toBeNull();
  });

  it('the question names commits, tasks, base and short SHA; control characters in the summary are stripped', () => {
    const t = promptText({ project: 'p', base: 'main', sha: SHA, commits: 1, tasks: [], mode: 'pull-request', summary: 'evil\u001b[31m', subjects: [], remoteUrl: null });
    expect(t.split('\n')[0]).toBe(`Publish 1 commit to main at ${SHA.slice(0, 7)}?`);
    expect(t).toContain('How: push a branch and open a pull request');
    expect(t).not.toContain('\u001b');
  });
});
