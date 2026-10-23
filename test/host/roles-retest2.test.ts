// task-33.6 scoped retest 3: format-character boundaries, 240/241 cap in every single-line field, stored-state rendering.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import { projectPaths } from '../../src/core/paths.js';
import { loadProjectJson } from '../../src/host/project.js';
import { runInit } from '../../src/host/install.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { formatProposalLine, formatShow, MAX_PROPOSAL_LINE, proposeRole, showProposal } from '../../src/runtime/role-proposals.js';
import { escapeFormatChars } from '../../src/core/control-chars.js';
import { dockerUp, makeRepo, withHome } from './fixtures.js';

let env: ReturnType<typeof withHome>;
let db: RuntimeDb;
beforeEach(() => { env = withHome(); db = new RuntimeDb(':memory:'); });
afterEach(() => { db.close(); env.cleanup(); });
const ROLE = { description: 'Writes notes.', contract: 'producer', edits: { paths: ['docs/research/**'] } };

async function ctx() {
  const repo = makeRepo(env.root);
  const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp })).plan.projectId);
  return { db, config: validateConfig(JSON.parse(readFileSync(join(projectPaths(project.projectId).runtimeDir, 'config.json'), 'utf8'))) };
}
const propose = async (c: Awaited<ReturnType<typeof ctx>>, p: unknown) => {
  const f = join(env.root, `p-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(p));
  return proposeRole(c, f);
};
const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, '0');

describe('format-character ranges', () => {
  const bad = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0xfeff, 0x2028, 0x2029, 0xe0000, 0xe0001, 0xe0020, 0xe007f];
  it.each(bad.map((c) => [hex(c), c] as const))('U+%s is escaped', (_h, cp) => {
    expect(escapeFormatChars(`a${String.fromCodePoint(cp)}b`)).toBe(`a<U+${hex(cp)}>b`);
  });
  it('astral tag chars rejected in prompt and description; neighbours U+E0080 and U+DFFFF-ish plain text accepted', async () => {
    const c = await ctx();
    await expect(propose(c, { name: 'researcher', role: ROLE, promptText: 'x\u{e0000}', reason: 'r' })).rejects.toThrow(/format or invisible/);
    await expect(propose(c, { name: 'researcher', role: ROLE, promptText: 'x\u{e007f}', reason: 'r' })).rejects.toThrow(/format or invisible/);
    await expect(propose(c, { name: 'researcher', role: { ...ROLE, description: 'x\u{e0041}' }, promptText: 'x', reason: 'r' })).rejects.toThrow(/format or invisible/);
    await expect(propose(c, { name: 'researcher', role: ROLE, promptText: 'emoji \u{1F600} 日本 café', reason: 'r' })).resolves.toBeTruthy();
  });
});

describe('240/241 cap per single-line field', () => {
  const fields: [string, (s: string) => unknown][] = [
    ['description', (s) => ({ name: 'researcher', role: { ...ROLE, description: s }, promptText: 'x', reason: 'r' })],
    ['reason', (s) => ({ name: 'researcher', role: ROLE, promptText: 'x', reason: s })],
    ['edits path', (s) => ({ name: 'researcher', role: { ...ROLE, edits: { paths: [s] } }, promptText: 'x', reason: 'r' })],
  ];
  it.each(fields)('%s: 240 ok, 241 rejected', async (_n, mk) => {
    const c = await ctx();
    await expect(propose(c, mk('d'.repeat(MAX_PROPOSAL_LINE)))).resolves.toBeTruthy();
    await expect(propose(c, mk('d'.repeat(MAX_PROPOSAL_LINE + 1)))).rejects.toThrow();
  });
  it('prompt body is not capped', async () => {
    const c = await ctx();
    await expect(propose(c, { name: 'researcher', role: ROLE, promptText: ('p'.repeat(500) + '\n').repeat(20), reason: 'r' })).resolves.toBeTruthy();
  });
});

describe('stored state injected directly then rendered', () => {
  it('show/list render stored bad reason and description as markers', async () => {
    const c = await ctx();
    const ok = await propose(c, { name: 'researcher', role: ROLE, promptText: 'x', reason: 'r' });
    const row = db.roleProposal(ok.proposalId)!;
    const tampered = JSON.parse(row.json);
    tampered.role.description = 'notes ‮hidden\u{e0049}';
    tampered.reason = 'why ​ end';
    (db as any).exec("UPDATE role_proposals SET json = ? WHERE id = ?", JSON.stringify(tampered), ok.proposalId);
    const shown = await showProposal(c, ok.proposalId);
    const text = formatShow(shown);
    for (const ch of ['‮', '\u{e0049}', '​', ' ']) expect(text.includes(ch)).toBe(false);
    expect(text).toContain('<U+200B><U+2028>'); expect(text).toContain('no longer valid');
    expect(formatProposalLine({ ...shown.view, reason: 'a b' } as never)).toContain('<U+2029>');
  });
});
