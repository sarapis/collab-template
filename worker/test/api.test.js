import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { CLASSIC } from './classic.js';

// A stub D1 that records what was asked of it. Enough to hold the rules that
// matter -- authorship, the revision trail, permission -- without a network.
function db() {
  const rows = { answers: [], answer_revisions: [], comments: [], seen: [], start_seen: [] };
  const run = (sql, args) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT INTO answers')) rows.answers.push({ id: args[0], question_id: args[1], author_sub: args[2], author_name: args[3], body: args[4], created_at: args[5], revision_count: 0, updated_at: null });
    else if (s.startsWith('INSERT INTO answer_revisions')) rows.answer_revisions.push({ id: args[0], answer_id: args[1], body: args[2], replaced_at: args[3] });
    else if (s.startsWith('INSERT INTO comments')) rows.comments.push({ id: args[0], thread: args[1], doc: args[2], section: args[3], parent_id: args[4], author_sub: args[5], author_name: args[6], body: args[7], created_at: args[8] });
    else if (s.startsWith('INSERT INTO seen')) {
      const row = rows.seen.find((r) => r.sub === args[0]);
      if (row) row.last_seen_at = args[1]; else rows.seen.push({ sub: args[0], last_seen_at: args[1] });
    }
    // ON CONFLICT DO NOTHING: the FIRST sighting is the one that is kept.
    else if (s.startsWith('INSERT INTO start_seen')) {
      if (!rows.start_seen.some((r) => r.sub === args[0])) rows.start_seen.push({ sub: args[0], at: args[1] });
    }
    else if (s.startsWith('UPDATE answers SET body')) {
      const a = rows.answers.find((r) => r.id === args[2]);
      if (a) { a.body = args[0]; a.updated_at = args[1]; a.revision_count += 1; }
    }
    return { success: true };
  };
  const all = (sql, args) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    // A query with no bound ids wants every row -- the notifications endpoint
    // reads the whole answers table to work out who has answered what.
    if (s.includes('FROM answers')) {
      if (!args.length) {
        // The notifications query groups by question and author, keeping the
        // latest answer of each pair.
        const latest = new Map();
        for (const r of rows.answers) {
          const key = r.question_id + '\u0000' + r.author_sub;
          const seen = latest.get(key);
          if (!seen || r.created_at > seen.latest) {
            latest.set(key, { question_id: r.question_id, author_sub: r.author_sub, latest: r.created_at });
          }
        }
        return { results: [...latest.values()] };
      }
      return { results: rows.answers.filter((r) => args.includes(r.question_id)) };
    }
    if (s.includes('FROM chat_turns')) return { results: [] };
    if (s.includes('FROM comments WHERE doc')) return { results: rows.comments.filter((c) => c.doc === args[0] || c.doc == null) };
    if (s.includes('FROM comments')) return { results: rows.comments };
    return { results: [] };
  };
  const first = (sql, args) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM users WHERE email')) return USERS.find((u) => u.email === args[0]) || null;
    if (s.startsWith('SELECT * FROM answers')) return rows.answers.find((r) => r.id === args[0]) || null;
    if (s.includes('COUNT(*) AS n FROM comments')) return { n: rows.comments.filter((c) => c.created_at > args[0] && c.author_sub !== args[1]).length };
    if (s.startsWith('SELECT last_seen_at FROM seen')) return rows.seen.find((r) => r.sub === args[0]) || null;
    if (s.startsWith('SELECT at FROM start_seen')) return rows.start_seen.find((r) => r.sub === args[0]) || null;
    return null;
  };
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => { args = a; return stmt; },
      run: async () => run(sql, args),
      all: async () => all(sql, args),
      first: async () => first(sql, args),
    };
    return stmt;
  };
  return { rows, prepare, batch: async (stmts) => { for (const s of stmts) await s.run(); } };
}

// The roster is a table now, so the stub carries one.
const USERS = [
  { email: 'devin@example.org', name: 'Devin', role: 'contributor', audiences: '["devin"]', disabled_at: null },
  { email: 'olivia@example.org', name: 'Olivia', role: 'contributor', audiences: '["olivia"]', disabled_at: null },
  { email: 'guest@example.org', name: 'Guest', role: 'user', audiences: '["devin"]', disabled_at: null },
];

const env = (DB) => ({ DB, COLLAB_HOST: CLASSIC, AGENT_TOKENS: '{}', PUBLIC_READ: 'false', DEV_SIGN_IN: 'true' });
const as = (who, init = {}) => new Request('https://x' + (init.path || '/api/me'), {
  method: init.method || 'GET',
  headers: Object.assign(who ? { cookie: `collab_session=${who}` } : {}, init.body ? { 'content-type': 'application/json' } : {}),
  body: init.body ? JSON.stringify(init.body) : undefined,
});

test('an unknown caller is anonymous and cannot write', async () => {
  const e = env(db());
  const me = await worker.fetch(as(null), e).then((r) => r.json());
  assert.equal(me.authenticated, false);
  // ⚠️ 401, not 403. On a PRIVATE instance an anonymous caller is now stopped at
  // the door by the read gate rather than reaching the handler and being told
  // "not permitted" — "we do not know you" is the truer answer, and it is the
  // same gate that stops them reading. On a public instance the write still
  // fails at can_write with 403, which is the case below.
  const r = await worker.fetch(as(null, { path: '/api/answers', method: 'POST', body: { question_id: 'p:a', body: 'x' } }), e);
  assert.equal(r.status, 401);
});

test('a roster member is identified and may write', async () => {
  const e = env(db());
  const me = await worker.fetch(as('devin@example.org'), e).then((r) => r.json());
  assert.equal(me.name, 'Devin');
  assert.deepEqual(me.audiences, ['devin']);
  const r = await worker.fetch(as('devin@example.org', { path: '/api/answers', method: 'POST', body: { question_id: 'p:a', body: 'Forty-eight hours.' } }), e);
  assert.equal(r.status, 201);
  assert.equal(e.DB.rows.answers[0].author_sub, 'devin@example.org');
});

test('an answer comes back marked mine only for its author', async () => {
  const e = env(db());
  await worker.fetch(as('devin@example.org', { path: '/api/answers', method: 'POST', body: { question_id: 'p:a', body: 'x' } }), e);
  const mine = await worker.fetch(as('devin@example.org', { path: '/api/answers?q=p:a' }), e).then((r) => r.json());
  assert.equal(mine.answers['p:a'][0].mine, true);
  const theirs = await worker.fetch(as('olivia@example.org', { path: '/api/answers?q=p:a' }), e).then((r) => r.json());
  assert.equal(theirs.answers['p:a'][0].mine, false);
});

test('editing an answer keeps the previous text and marks the edit', async () => {
  // An answer is evidence a document quotes. A silent rewrite could leave a
  // passage resting on text that no longer justifies it.
  const e = env(db());
  await worker.fetch(as('devin@example.org', { path: '/api/answers', method: 'POST', body: { question_id: 'p:a', body: 'Forty-eight hours.' } }), e);
  const id = e.DB.rows.answers[0].id;
  const r = await worker.fetch(as('devin@example.org', { path: `/api/answers/${id}`, method: 'PATCH', body: { body: 'Seventy-two hours.' } }), e);
  assert.equal(r.status, 200);
  assert.equal(e.DB.rows.answer_revisions.length, 1);
  assert.equal(e.DB.rows.answer_revisions[0].body, 'Forty-eight hours.');
  assert.equal(e.DB.rows.answers[0].revision_count, 1);
});

test('nobody may edit somebody else\'s answer', async () => {
  const e = env(db());
  await worker.fetch(as('devin@example.org', { path: '/api/answers', method: 'POST', body: { question_id: 'p:a', body: 'x' } }), e);
  const id = e.DB.rows.answers[0].id;
  const r = await worker.fetch(as('olivia@example.org', { path: `/api/answers/${id}`, method: 'PATCH', body: { body: 'no' } }), e);
  assert.equal(r.status, 403);
  assert.equal(e.DB.rows.answer_revisions.length, 0);
});

test('an unchanged edit records no revision', async () => {
  const e = env(db());
  await worker.fetch(as('devin@example.org', { path: '/api/answers', method: 'POST', body: { question_id: 'p:a', body: 'same' } }), e);
  const id = e.DB.rows.answers[0].id;
  await worker.fetch(as('devin@example.org', { path: `/api/answers/${id}`, method: 'PATCH', body: { body: 'same' } }), e);
  assert.equal(e.DB.rows.answer_revisions.length, 0);
});

test('a route the server does not declare is a 404, not a silent 200', async () => {
  const e = env(db());
  const r = await worker.fetch(as('devin@example.org', { path: '/api/imaginary' }), e);
  assert.equal(r.status, 404);
});

test('an agent bearer token resolves to a person, not to a machine', async () => {
  // Access service tokens attribute to a token; an answer a document quotes
  // needs a human name on it.
  const raw = 'test-token-value';
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const e = { ...env(db()), AGENT_TOKENS: JSON.stringify({ 'devin@example.org': `sha256:${hex}` }) };
  const req = new Request('https://x/api/me', { headers: { authorization: `Bearer ${raw}` } });
  const me = await worker.fetch(req, e).then((r) => r.json());
  assert.equal(me.sub, 'devin@example.org');
  assert.equal(me.via, 'agent');
});

test('a wrong bearer token is anonymous', async () => {
  const e = { ...env(db()), AGENT_TOKENS: JSON.stringify({ 'devin@example.org': 'sha256:' + '0'.repeat(64) }) };
  const req = new Request('https://x/api/me', { headers: { authorization: 'Bearer nope' } });
  const me = await worker.fetch(req, e).then((r) => r.json());
  assert.equal(me.authenticated, false);
});

test('comments are readable and stay separate from answers', async () => {
  const e = env(db());
  await worker.fetch(as('olivia@example.org', { path: '/api/comments', method: 'POST', body: { body: 'The cadence section is unclear.' } }), e);
  const list = await worker.fetch(as('devin@example.org', { path: '/api/comments' }), e).then((r) => r.json());
  assert.equal(list.comments.length, 1);
  assert.equal(list.comments[0].author_name, 'Olivia');
  assert.equal(e.DB.rows.answers.length, 0);
});

// --- notifications ---------------------------------------------------------

function withManifest(DB, questions) {
  return {
    DB, COLLAB_HOST: CLASSIC, AGENT_TOKENS: '{}', PUBLIC_READ: 'false', DEV_SIGN_IN: 'true',
    ASSETS: { fetch: async () => new Response(JSON.stringify({
      questions, audiences: { devin: { name: 'Devin' }, olivia: { name: 'Olivia' } },
      asked_rounds: { r1: { new: false, opened: '2026-09-16T00:00:00.000Z' },
                      r2: { new: true, opened: '2026-09-17T17:00:00.000Z' } },
    }), { status: 200 }) },
  };
}

const Q = (id, audience, extra = {}) => ({ id, audience, asked: 'r1', resolved: null, hidden: false, ...extra });

test('a question you have answered stops waiting for you', async () => {
  // ⚠️ The whole point. "Waiting" used to mean "not resolved", so eight answers
  // were posted and the number did not move -- resolving is a contributor
  // folding the answer into the prose, which is a different person's job.
  const e = withManifest(db(), [Q('p:a', 'devin'), Q('p:b', 'devin')]);
  const before = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(before.items.find((i) => i.kind === 'waiting').count, 2);

  await worker.fetch(as('devin@example.org', { path: '/api/answers', method: 'POST', body: { question_id: 'p:a', body: 'answered' } }), e);
  const after = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(after.items.find((i) => i.kind === 'waiting').count, 1);
});

test('answering does not resolve it — it moves to the contributor', async () => {
  const e = withManifest(db(), [Q('p:a', 'devin')]);
  await worker.fetch(as('devin@example.org', { path: '/api/answers', method: 'POST', body: { question_id: 'p:a', body: 'x' } }), e);
  const n = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(n.items.some((i) => i.kind === 'waiting'), false);
  const fold = n.items.find((i) => i.kind === 'fold');
  assert.equal(fold.count, 1);
  assert.equal(fold.forYou, false, 'folding in is work, not a notification about you');
});

test('a resolved question is waiting for nobody', async () => {
  const e = withManifest(db(), [Q('p:a', 'devin', { resolved: '#somewhere' })]);
  const n = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.deepEqual(n.items, []);
  assert.equal(n.total, 0);
});

test('a question addressed to somebody else is not waiting for you', async () => {
  const e = withManifest(db(), [Q('p:a', 'olivia')]);
  const n = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(n.items.some((i) => i.kind === 'waiting'), false);
  assert.match(n.items.find((i) => i.kind === 'others').text, /waiting on Olivia/);
});

test('the total counts only what is for you', async () => {
  // A contributor should not see a badge counting their own backlog of work.
  const e = withManifest(db(), [Q('p:a', 'devin'), Q('p:b', 'olivia')]);
  const n = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(n.total, 1);
  assert.ok(n.items.length > 1, 'the feed should still show the rest');
});

test('a new round is reported as detail, not as a second count', async () => {
  const e = withManifest(db(), [Q('p:a', 'devin'), Q('p:b', 'devin', { asked: 'r2' })]);
  const n = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  const waiting = n.items.find((i) => i.kind === 'waiting');
  assert.equal(waiting.count, 2);
  assert.match(waiting.detail, /1 reworded or newly asked/);
});

test('an anonymous caller is told nothing', async () => {
  // ⚠️ This used to pass by reaching getNotifications, which returned an empty
  // list for a caller it did not recognise. That was the right answer arrived
  // at by the wrong route: the handler was being asked at all. It is now
  // refused at the door, and the emptiness is no longer load-bearing.
  const r = await worker.fetch(as(null, { path: '/api/notifications' }), withManifest(db(), [Q('p:a', 'devin')]));
  assert.equal(r.status, 401);
  assert.equal((await r.text()).includes('items'), false);
});

test('a public instance still tells an anonymous caller nothing', async () => {
  // The read gate opens, and the handler's own answer for an unknown person is
  // the empty one it always was.
  const e = withManifest(db(), [Q('p:a', 'devin')]);
  const n = await worker.fetch(as(null, { path: '/api/notifications' }), { ...e, PUBLIC_READ: 'true' }).then((r) => r.json());
  assert.deepEqual(n.items, []);
  assert.equal(n.total, 0);
});

test('a question reworded since your answer is waiting for you again', async () => {
  // ⚠️ The failure this exists for: two questions were rewritten after "not sure
  // what this means", and neither came back to the person they were addressed
  // to, because "has an answer" was treated as terminal.
  const DB = db();
  const e = withManifest(DB, [{ id: 'p:a', audience: 'devin', asked: 'r2', resolved: null, hidden: false }]);
  e.ASSETS = { fetch: async () => new Response(JSON.stringify({
    questions: [{ id: 'p:a', audience: 'devin', asked: 'r2', resolved: null, hidden: false }],
    audiences: { devin: { name: 'Devin' } },
    asked_rounds: { r1: { new: false, opened: '2026-09-16T00:00:00.000Z' }, r2: { new: true, opened: '2026-09-17T17:00:00.000Z' } },
  }), { status: 200 }) };

  // An answer from before the rewording.
  DB.rows.answers.push({ id: 'x', question_id: 'p:a', author_sub: 'devin@example.org', author_name: 'Devin',
    body: 'not sure what this means', created_at: '2026-09-17T16:36:00.000Z', revision_count: 0 });

  const before = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(before.items.find((i) => i.kind === 'waiting').count, 1, 'the reworded question should be waiting again');
  assert.match(before.items.find((i) => i.kind === 'waiting').detail, /an earlier answer is still on the record/);

  // Answering the reworded version settles it.
  DB.rows.answers.push({ id: 'y', question_id: 'p:a', author_sub: 'devin@example.org', author_name: 'Devin',
    body: 'they came with the template', created_at: '2026-09-17T18:00:00.000Z', revision_count: 0 });
  const after = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(after.items.some((i) => i.kind === 'waiting'), false);
});

test('an answer written after its round still counts', async () => {
  const DB = db();
  const e = withManifest(DB, [{ id: 'p:a', audience: 'devin', asked: 'r1', resolved: null, hidden: false }]);
  DB.rows.answers.push({ id: 'x', question_id: 'p:a', author_sub: 'devin@example.org', author_name: 'Devin',
    body: 'answered', created_at: '2026-09-17T10:00:00.000Z', revision_count: 0 });
  const n = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(n.items.some((i) => i.kind === 'waiting'), false);
});

// --- the badge counts news, the page counts work ----------------------------
//
// ⚠️ These exist because the badge stood at ten for days. Ten answers really
// were waiting to be folded in, and that is worth showing — but a number that
// never changes is not an alert, and the person carrying it stops reading it.

test('the badge goes quiet once you have looked, and the page does not', async () => {
  const e = withManifest(db(), [Q('p:a', 'devin'), Q('p:b', 'devin')]);
  const before = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(before.total, 2, 'never looked, so both are news');

  await worker.fetch(as('devin@example.org', { path: '/api/seen', method: 'POST' }), e);

  const after = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(after.total, 0, 'nothing is new any more');
  assert.equal(after.items.find((i) => i.kind === 'waiting').count, 2, 'and both are still waiting');
});

test('rewording a question into a new round makes it news again', async () => {
  // The other half of why rounds carry a date: a question you have already
  // ignored is not news, and the same question asked differently is.
  const e = withManifest(db(), [Q('p:a', 'devin')]);
  await worker.fetch(as('devin@example.org', { path: '/api/seen', method: 'POST' }), e);
  const quiet = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(quiet.total, 0);

  // r3 opens after the visit above, which is what rewording does.
  const reworded = withManifest(e.DB, [Q('p:a', 'devin', { asked: 'r3' })]);
  reworded.ASSETS = { fetch: async () => new Response(JSON.stringify({
    questions: [Q('p:a', 'devin', { asked: 'r3' })],
    audiences: { devin: { name: 'Devin' } },
    asked_rounds: { r3: { new: true, opened: new Date(Date.now() + 60000).toISOString() } },
  }), { status: 200 }) };
  const loud = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), reworded).then((r) => r.json());
  assert.equal(loud.total, 1, 'a reworded question is news again');
});

test('a backlog of answers to fold is on the page and not in the badge', async () => {
  const e = withManifest(db(), [Q('p:a', 'devin')]);
  await worker.fetch(as('devin@example.org', { path: '/api/answers', method: 'POST', body: { question_id: 'p:a', body: 'an answer' } }), e);

  const fresh = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(fresh.total, 1, 'a new answer is worth one alert');
  assert.match(fresh.items.find((i) => i.kind === 'fold').text, /1 new answer/);

  await worker.fetch(as('devin@example.org', { path: '/api/seen', method: 'POST' }), e);
  const later = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(later.total, 0, 'the same answer is not news twice');
  const fold = later.items.find((i) => i.kind === 'fold');
  assert.equal(fold.count, 1, 'and it is still outstanding on the page');
  assert.match(fold.text, /1 answer ready to fold/);
});

test('work waiting on somebody else never raises the badge', async () => {
  const e = withManifest(db(), [Q('p:a', 'olivia')]);
  const n = await worker.fetch(as('devin@example.org', { path: '/api/notifications' }), e).then((r) => r.json());
  assert.equal(n.total, 0);
  assert.equal(n.items.find((i) => i.kind === 'others').count, 1);
});
