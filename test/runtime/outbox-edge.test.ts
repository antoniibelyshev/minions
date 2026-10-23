// Tester edge cases for task-2.3 (notification outbox and owner controls): schema migration 3 -> 4 on a
// populated database, dedup across connections, backoff boundaries and pending ordering, best-effort
// `work cancel` never deleting worktrees or branches, controls not firing on ordinary sentences, and
// credential masking of stored send errors.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import {
  ack, BACKOFF_BASE_MS, counts, enqueue, fail, flush, pending, redactError,
  type NotificationTransport, type OutboxItem,
} from '../../src/runtime/outbox.js';
import { cancelWork, formatCancel, matchControl } from '../../src/runtime/controls.js';
import { git } from '../../src/runtime/worktree.js';
import { makeEnv, tmp } from './fixtures.js';

const dbPath = () => join(tmp('minions-outbox-edge-'), 'state', 'minions.db');

function clock(start = Date.parse('2026-10-23T10:00:00.000Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

class FakeTransport implements NotificationTransport {
  readonly name = 'fake';
  failKeys = new Set<string>();
  sent: string[] = [];
  async send(item: OutboxItem): Promise<void> {
    if (this.failKeys.has(item.key)) throw new Error('503 Service Unavailable');
    this.sent.push(item.key);
  }
}

describe('runtime db migration 3 -> 4 (notification outbox)', () => {
  it('upgrades a populated v3 database without data loss and re-opens idempotently', () => {
    const path = dbPath();
    // A genuine v3 database: this build's schema with the outbox rolled back, plus existing rows.
    const v3 = new RuntimeDb(path);
    v3.sql.exec('DROP INDEX outbox_pending; DROP TABLE outbox; ALTER TABLE leases DROP COLUMN harness');
    v3.sql.prepare("INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES ('lease-x','task-1','engineer',1,1,'2026-01-01T00:00:00Z','completed')").run();
    v3.sql.prepare("INSERT INTO approvals (task_id, scope, head_sha, approved_by, note, recorded_at, signature) VALUES ('task-1','publish',?,'owner',NULL,'2026-01-01T00:00:00Z','sig')").run('a'.repeat(40));
    v3.addEvent('note', 'task-1', { before: 'upgrade' });
    v3.setMeta('schema_version', '3');
    v3.close();

    const up = new RuntimeDb(path);
    expect(up.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    expect(up.get<{ id: string; status: string }>("SELECT id, status FROM leases WHERE id = 'lease-x'")).toEqual({ id: 'lease-x', status: 'completed' });
    expect(up.approvals('task-1', 'publish', 'a'.repeat(40))).toEqual([expect.objectContaining({ approved_by: 'owner', signature: 'sig' })]);
    expect(up.events('task-1').map((e) => e.kind)).toContain('note');
    expect(up.get('SELECT name FROM sqlite_master WHERE name = ?', 'outbox_pending')).toBeTruthy();
    enqueue(up, { key: 'goal-ack:1', kind: 'goal-ack', text: 'Got it.' });
    up.close();

    // Re-opening at v4 runs no migration again and keeps the outbox rows.
    const again = new RuntimeDb(path);
    expect(again.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
    expect(pending(again).map((i) => i.key)).toEqual(['goal-ack:1']);
    expect(again.get<{ id: string }>("SELECT id FROM leases WHERE id = 'lease-x'")).toBeTruthy();
    again.close();
  });
});

describe('outbox dedup across connections', () => {
  it('two runtime connections enqueueing the same key create exactly one row; ack from one is seen by the other', () => {
    const path = dbPath();
    const a = new RuntimeDb(path);
    const b = new RuntimeDb(path);
    const results = [
      enqueue(a, { key: 'delivered:task-7:abc', kind: 'delivered', taskId: 'task-7', text: 'first' }),
      enqueue(b, { key: 'delivered:task-7:abc', kind: 'delivered', taskId: 'task-7', text: 'second' }),
      enqueue(a, { key: '  delivered:task-7:abc  ', kind: 'delivered', taskId: 'task-7', text: 'third (key trimmed)' }),
    ];
    expect(results.map((r) => r.created)).toEqual([true, false, false]);
    expect(results.every((r) => r.item.text === 'first')).toBe(true);
    expect(a.all('SELECT dedup_key FROM outbox')).toHaveLength(1);
    expect(a.events('task-7').filter((e) => e.kind === 'notify-enqueue')).toHaveLength(1);

    ack(b, 'delivered:task-7:abc', 'telegram');
    expect(enqueue(a, { key: 'delivered:task-7:abc', kind: 'delivered', text: 'again' })).toMatchObject({ created: false, item: { deliveredVia: 'telegram' } });
    expect(pending(a, { includeWaiting: true })).toEqual([]);
    a.close();
    b.close();
  });
});

describe('outbox backoff and ordering', () => {
  it('an item becomes due exactly at nextAttemptAt, not a millisecond before', () => {
    const db = new RuntimeDb(dbPath());
    const c = clock();
    enqueue(db, { key: 'k', kind: 'status', text: 'x' }, c.now);
    fail(db, 'k', 'down', c.now);
    c.advance(BACKOFF_BASE_MS - 1);
    expect(pending(db, {}, c.now)).toEqual([]);
    expect(counts(db, c.now)).toMatchObject({ pending: 1, due: 0, waiting: 1 });
    c.advance(1);
    expect(pending(db, {}, c.now).map((i) => i.key)).toEqual(['k']);
    expect(counts(db, c.now)).toMatchObject({ pending: 1, due: 1, waiting: 0 });
  });

  it('keeps creation order (ties broken by insertion order) and a retried item keeps its original place', () => {
    const db = new RuntimeDb(dbPath());
    const c = clock();
    for (const k of ['z', 'm', 'a']) enqueue(db, { key: k, kind: 'other', text: k }, c.now); // same timestamp
    c.advance(10);
    enqueue(db, { key: 'later', kind: 'other', text: 'later' }, c.now);
    expect(pending(db, {}, c.now).map((i) => i.key)).toEqual(['z', 'm', 'a', 'later']);
    fail(db, 'z', 'down', c.now);
    expect(pending(db, {}, c.now).map((i) => i.key)).toEqual(['m', 'a', 'later']);
    c.advance(BACKOFF_BASE_MS);
    expect(pending(db, {}, c.now).map((i) => i.key)).toEqual(['z', 'm', 'a', 'later']);
  });

  it('flush honours limit, skips items inside a backoff, and records the failure count', async () => {
    const db = new RuntimeDb(dbPath());
    const c = clock();
    const t = new FakeTransport();
    for (const k of ['a', 'b', 'c']) { enqueue(db, { key: k, kind: 'other', text: k }, c.now); c.advance(1); }
    t.failKeys.add('a');
    expect(await flush(db, t, {}, c.now)).toMatchObject({ sent: [], failed: [{ key: 'a', error: '503 Service Unavailable' }], remaining: 3 });
    // 'a' waits; the next wake sends the others, bounded by the limit.
    expect(await flush(db, t, { limit: 1 }, c.now)).toMatchObject({ sent: ['b'], failed: [], remaining: 2 });
    expect(await flush(db, t, {}, c.now)).toMatchObject({ sent: ['c'], remaining: 1 });
    t.failKeys.clear();
    c.advance(BACKOFF_BASE_MS);
    expect(await flush(db, t, {}, c.now)).toMatchObject({ sent: ['a'], remaining: 0 });
    expect(t.sent).toEqual(['b', 'c', 'a']);
    expect(db.get<{ attempts: number; delivered_via: string }>("SELECT attempts, delivered_via FROM outbox WHERE dedup_key = 'a'")).toEqual({ attempts: 1, delivered_via: 'fake' });
  });

  it('an empty error is stored as a generic reason', () => {
    const db = new RuntimeDb(dbPath());
    enqueue(db, { key: 'k', kind: 'other', text: 'x' });
    expect(fail(db, 'k', '   ').lastError).toBe('send failed');
  });
});

describe('controls do not fire on ordinary sentences', () => {
  it.each([
    'resume work on the login page',
    'what is the status of task-7',
    'status of the deploy?',
    'can you sync the docs with the code',
    'pause intake please',
    'stop',
    'cancel everything',
    'cancel task-',
    'cancel task-2.3 now',
    'stop the build',
  ])('"%s" is not a control', (text) => {
    expect(matchControl(text)).toBeNull();
  });

  it('task ids are normalized to lowercase and keep sub-task dots', () => {
    expect(matchControl('STOP TASK-2.3.1!')?.argv).toEqual(['work', 'cancel', 'task-2.3.1', '--reason', 'owner cancelled']);
  });
});

describe('minions work cancel never deletes worktrees or branches', () => {
  it('keeps the worktree directory and branch after releasing; unknown and idle ids are reported, not errors', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', title: 'One' });
    const brief = await env.sched.claim('task-1', 'engineer');
    expect(existsSync(brief.worktree)).toBe(true);

    const r = await cancelWork({ db: env.db, release: (id, why) => env.sched.release(id, why), backlog: env.backlog }, { taskIds: ['TASK-1', 'task-404'] }, 'owner cancelled');
    expect(r.released.map((x) => x.leaseId)).toEqual([brief.leaseId]);
    expect(r.idle).toEqual(['task-404']);
    expect(existsSync(brief.worktree)).toBe(true);
    expect((await git(env.layout.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${brief.branch}`], true)).code).toBe(0);
    expect(formatCancel(r)).toContain('worktrees kept');

    // Repeating the cancel is a harmless no-op.
    const again = await cancelWork({ db: env.db, release: (id, why) => env.sched.release(id, why), backlog: env.backlog }, { taskIds: ['task-1'] }, 'again');
    expect(again).toEqual({ released: [], failed: [], blocked: [], blockFailed: [], idle: ['task-1'] });
    expect(formatCancel(again)).toBe('no active leases released\nno active lease: task-1');
    expect(existsSync(brief.worktree)).toBe(true);
  });

  it('--all with no active leases releases nothing and reports no idle ids', async () => {
    const env = makeEnv();
    const r = await cancelWork({ db: env.db, release: async () => { throw new Error('must not be called'); }, backlog: env.backlog }, { taskIds: [], all: true }, 'x');
    expect(r).toEqual({ released: [], failed: [], blocked: [], blockFailed: [], idle: [] });
  });
});

describe('credential masking of stored send errors', () => {
  it.each([
    ['401 for bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'],
    ['remote: ghp_abcdefghijklmnopqrstuvwxyz0123456789 denied', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r', 'ghs_abcdefghijklmnopqrstuvwxyz0123'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
    ['Authorization: Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
    ['token=abcdefghijklmnop', 'abcdefghijklmnop'],
    ['login failed: password=hunter2 user=bob', 'hunter2'],
    ['PASSWORD: Sup3rS3cret!', 'Sup3rS3cret!'],
    ['db passwd=letmein', 'letmein'],
    ['GET /v1?api_key=k-12345&q=1 failed', 'k-12345'],
    ['ApiKey: abc123xyz', 'abc123xyz'],
    ['apikey=QWERTY', 'QWERTY'],
    ['api-key = zzz999', 'zzz999'],
    ['secret: s3cr3t', 's3cr3t'],
    ['client_secret=cs_live_42', 'cs_live_42'],
    ['{"password":"p@ss word"}', 'p@ss'],
    ['{"password":"p@ss phrase"}', 'phrase'],
    ["password='two words here'", 'words here'],
    ["config {'Secret': 'shh'}", 'shh'],
    ['upstream said token abc123def456ghi', 'abc123def456ghi'],
    ['Authorization: token 0123456789abcdef0123456789abcdef01234567', '0123456789abcdef0123456789abcdef01234567'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['authorization=Digest username-and-response', 'username-and-response'],
    ['{"Authorization":"token 0123456789abcdef"}', '0123456789abcdef'],
    ['secret_key=sk-abc', 'sk-abc'],
    ['access_key: AKIAEXAMPLE', 'AKIAEXAMPLE'],
    ['private-key=pk_9', 'pk_9'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'wJalrXUtnFEMI'],
    ['clone https://bob:hunter2@example.com/r.git failed', 'hunter2'],
  ])('masks %s', (input, secret) => {
    expect(redactError(input)).not.toContain(secret);
    expect(redactError(input)).toContain('[redacted]');
  });

  // Known gaps (reported to the coordinator as a defect): the bot token inside a Telegram Bot API URL
  // (`/bot<id>:<secret>/`) has no word boundary before the id, and a JSON-quoted Authorization header
  // lets the `token|authorization` rule consume the quote instead of the bearer value. `it.fails`
  // keeps the suite green while documenting the leak; it turns red once redactError is fixed.
  it('masks the bot token inside a Telegram Bot API URL', () => {
    expect(redactError('POST https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage failed'))
      .not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  });

  it('keeps prose readable: only an actual token after Bearer is masked', () => {
    expect(redactError('401: Bearer token is missing')).toBe('401: Bearer token is missing');
    expect(redactError('invalid Bearer token; Bearer abcdefghijklmnop rejected')).toBe('invalid Bearer token; Bearer [redacted] rejected');
    expect(redactError('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [redacted]');
    expect(redactError('token expired, authorization required')).toBe('token expired, authorization required');
    expect(redactError('2 secrets found; password reset needed')).toBe('2 secrets found; password reset needed');
    expect(redactError('password=hunter2 api_key=abc')).toBe('password=[redacted] api_key=[redacted]');
    expect(redactError('Authorization: token 0123456789abcdef0123456789abcdef01234567')).toBe('Authorization: token [redacted]');
    expect(redactError('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: Basic [redacted]');
    expect(redactError('{"password":"p@ss word","user":"bob"}')).toBe('{"password":"[redacted]","user":"bob"}');
    expect(redactError('https://bob:hunter2@example.com/r.git')).toBe('https://bob:[redacted]@example.com/r.git');
    expect(redactError('see https://example.com:8080/path and monkey=banana')).toBe('see https://example.com:8080/path and monkey=banana');
  });

  it('cuts very long input before masking, so redaction stays fast and no secret survives', () => {
    const long = `${'a-'.repeat(100_000)} password=hunter2`;
    const t0 = Date.now();
    const out = redactError(long);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(redactError(`password=hunter2 ${'x'.repeat(10_000)}`)).not.toContain('hunter2');
  });

  it('masks the whole Digest Authorization header value (response, nonce, cnonce)', () => {
    expect(redactError('Authorization: Digest username="u", response="deadbeefcafe1234"')).toBe('Authorization: Digest [redacted]');
    const full = 'Authorization: Digest username="u", realm="r", nonce="n0nce42", uri="/", qop=auth, nc=00000001, cnonce="cn0nce42", response="deadbeef"\nretry later';
    expect(redactError(full)).toBe('Authorization: Digest [redacted] retry later');
  });

  it('masks Proxy-Authorization header values', () => {
    expect(redactError('Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Proxy-Authorization: Basic [redacted]');
    expect(redactError('Proxy-Authorization: Digest username="u", response="deadbeefcafe1234"')).toBe('Proxy-Authorization: Digest [redacted]');
  });

  it('masks an Authorization header inside a JSON string up to the closing quote', () => {
    expect(redactError('{"error":"bad header Authorization: Digest username=\\"u\\", response=\\"deadbeefcafe1234\\"","code":401}'))
      .toBe('{"error":"bad header Authorization: Digest [redacted]","code":401}');
    expect(redactError('{"Authorization":"Digest username=\\"u\\", nonce=\\"n0nce42\\"","x":"y"}')).toBe('{"Authorization":"Digest [redacted]","x":"y"}');
    expect(redactError('{"Authorization":"Basic dXNlcjpwYXNzd29yZA==","x":"y"}')).toBe('{"Authorization":"Basic [redacted]","x":"y"}');
    expect(redactError('error: "Authorization: Basic dXNlcjpwYXNzd29yZA==" rejected')).toBe('error: "Authorization: Basic [redacted]" rejected');
  });

  it('masks every Digest param when readable text follows the header', () => {
    expect(redactError('Authorization: Digest username="u", response="deadbeefcafe1234" -> 401 Unauthorized'))
      .toBe('Authorization: Digest [redacted] -> 401 Unauthorized');
    expect(redactError('Authorization: Digest username="u", response="deadbeefcafe1234" (retrying)'))
      .toBe('Authorization: Digest [redacted] (retrying)');
    expect(redactError('Authorization: Digest username="u" response="deadbeefcafe1234" nonce=n0nce42 tail words'))
      .toBe('Authorization: Digest [redacted] tail words');
    expect(redactError('Authorization: Digest username = "u" , nc = 00000001, response = "deadbeefcafe1234" end'))
      .toBe('Authorization: Digest [redacted] end');
    expect(redactError('Authorization: Digest realm="a b", response=deadbeefcafe1234; next')).toBe('Authorization: Digest [redacted] next');
  });

  it('masks a quoted Digest param whatever character follows its closing quote', () => {
    // Python dict repr: the header value sits in single quotes.
    const dict = `{'Authorization': 'Digest username="u", response="deadbeefcafe1234"'}`;
    expect(redactError(dict)).not.toContain('deadbeefcafe1234');
    expect(redactError(dict)).toBe("{'Authorization': 'Digest [redacted]");
    const header = 'Authorization: Digest username="u", response="deadbeefcafe1234"';
    for (const tail of [')', '.', ']', "'", '-', 'x', 'X', '_', '-> 401', '). retrying']) {
      const out = redactError(`${header}${tail}`);
      expect(out, tail).not.toContain('deadbeefcafe1234');
      expect(out, tail).toMatch(/^Authorization: Digest \[redacted\]/);
    }
    expect(redactError(`(${header})`)).toBe('(Authorization: Digest [redacted]');
    expect(redactError(`${header}.`)).toBe('Authorization: Digest [redacted]');
    expect(redactError('Authorization: Digest response="deadbeefcafe1234"x nonce="n0nce42"')).toBe('Authorization: Digest [redacted]');
    // Base64 padding before the closing quote of a JSON string is still not taken for a quoted value.
    expect(redactError('{"Authorization":"Basic dXNlcjpwYXNzd29yZA==","x":"y"}')).toBe('{"Authorization":"Basic [redacted]","x":"y"}');
    expect(redactError('["Authorization: Basic dXNlcjpwYXNzd29yZA==","next"]')).toBe('["Authorization: Basic [redacted]","next"]');
  });

  it('masks Digest params after a backslash-escaped quote in a quoted value', () => {
    expect(redactError('Authorization: Digest username="a\\"b", response="deadbeefcafe1234"')).toBe('Authorization: Digest [redacted]');
    expect(redactError('Authorization: Digest username="a\\"b, c", response="deadbeefcafe1234" -> 401')).toBe('Authorization: Digest [redacted] -> 401');
    // The same header logged inside a JSON string: the raw `\"` becomes `\\\"`, the param quotes `\"`.
    expect(redactError('{"error":"Authorization: Digest username=\\"a\\\\\\"b c\\", response=\\"deadbeefcafe1234\\"","code":401}'))
      .toBe('{"error":"Authorization: Digest [redacted]","code":401}');
    expect(redactError('{"error":"Authorization: Digest username=\\"John Doe\\", response=\\"deadbeefcafe1234\\""}'))
      .toBe('{"error":"Authorization: Digest [redacted]"}');
  });

  it('masks an unterminated quoted Digest value (a cut-off message) up to the line end', () => {
    expect(redactError('Authorization: Digest username="u", response="deadbeef cafe…\nnext')).toBe('Authorization: Digest [redacted] next');
  });

  it('masks a folded multi-line Authorization header', () => {
    expect(redactError('Authorization: Digest username="u",\n  response="deadbeefcafe1234"\nretry later')).toBe('Authorization: Digest [redacted] retry later');
  });

  it('keeps text after a token68 credential readable and the enclosing JSON intact', () => {
    expect(redactError('Authorization: Basic dXNlcjpwYXNzd29yZA==, retrying later')).toBe('Authorization: Basic [redacted], retrying later');
    expect(redactError('Authorization: NTLM TlRMTVNTUAABAAAAB4IIog== (step 1)')).toBe('Authorization: NTLM [redacted] (step 1)');
    expect(redactError('{"Authorization":"Basic dXNlcg=","x":"y"}')).toBe('{"Authorization":"Basic [redacted]","x":"y"}');
    expect(redactError('{"Authorization":"Basic dXNlcg==", "x": 1}')).toBe('{"Authorization":"Basic [redacted]", "x": 1}');
  });

  it('masks AWS SigV4 credentials and signatures', () => {
    const header = 'Authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-date, Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024 failed';
    expect(redactError(header)).toBe('Authorization: AWS4-HMAC-SHA256 [redacted] failed');
    expect(redactError('GET /b?X-Amz-Credential=AKIDEXAMPLE%2F2013&X-Amz-Signature=fe5f80f77d5fa3 403'))
      .toBe('GET /b?X-Amz-Credential=[redacted]&X-Amz-Signature=[redacted] 403');
  });

  it('masks a generated-looking value after apikey without a separator, but keeps prose', () => {
    expect(redactError('apikey sk_live_0123456789abcd rejected')).toBe('apikey [redacted] rejected');
    expect(redactError('apikey is missing')).toBe('apikey is missing');
  });

  it('masks a URL-encoded Authorization header', () => {
    expect(redactError('GET /x?h=Authorization%3A%20Basic%20dXNlcjpwYXNzd29yZA%3D%3D&y=1')).toBe('GET /x?h=Authorization%3A%20Basic%20[redacted]&y=1');
  });

  it.each(['="', 'a="', '\\', '\\"', ', a=', ' a=', '= ', ' ', '=\\"', 'a=\\"\\\\', ',', '"', '=', ' =  ', 'a="\\'])(
    'redacts a 100 KB adversarial Authorization value of %j quickly',
    (unit) => {
      const value = unit.repeat(Math.ceil(100_000 / unit.length));
      const t0 = Date.now();
      redactError(`Authorization: Digest ${value}`);
      redactError(`x Authorization: Basic ${value} Proxy-Authorization: Digest ${value}`);
      expect(Date.now() - t0).toBeLessThan(500);
    },
  );

  it('masks a bearer token in a JSON-quoted Authorization header', () => {
    expect(redactError('{"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"}')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});
