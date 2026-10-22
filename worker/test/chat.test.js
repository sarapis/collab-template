import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../src/index.js';
import { enforceRetention } from '../src/chat.js';
import { CLASSIC } from './classic.js';

const MANIFEST = fs.readFileSync('build/manifest.json', 'utf8');

function db(seed = []) {
  const rows = { chat_turns: [...seed], chat_rate: new Map() };
  const prepare = (sql) => {
    let args = [];
    const s = sql.replace(/\s+/g, ' ').trim();
    const stmt = {
      bind: (...a) => { args = a; return stmt; },
      run: async () => {
        if (s.startsWith('INSERT INTO chat_turns')) {
          rows.chat_turns.push({ id: args[0], session_id: args[1], author_sub: args[2], author_name: args[3],
            created_at: args[4], user_message: args[5], assistant_message: args[6], model: args[7], cited: args[8], error: args[9] });
          return { success: true };
        }
        if (s.startsWith('DELETE FROM chat_rate')) {
          let n = 0;
          for (const [k, v] of rows.chat_rate) if (v.expires_at < args[0]) { rows.chat_rate.delete(k); n++; }
          return { meta: { changes: n } };
        }
        if (s.startsWith('DELETE FROM chat_turns')) {
          const before = rows.chat_turns.length;
          rows.chat_turns = rows.chat_turns.filter((t) => !(t.created_at < args[0]));
          return { meta: { changes: before - rows.chat_turns.length } };
        }
        return { success: true };
      },
      all: async () => {
        if (s.includes('FROM chat_turns WHERE session_id = ? AND author_sub')) {
          return { results: rows.chat_turns.filter((t) => t.session_id === args[0] && t.author_sub === args[1]) };
        }
        if (s.includes('GROUP BY session_id')) {
          const by = {};
          for (const t of rows.chat_turns) (by[t.session_id] ||= []).push(t);
          return { results: Object.entries(by).map(([session_id, ts]) => ({ session_id, author_name: ts[0].author_name, turns: ts.length })) };
        }
        if (s.includes('FROM chat_turns WHERE session_id')) {
          return { results: rows.chat_turns.filter((t) => t.session_id === args[0]) };
        }
        return { results: [] };
      },
      first: async () => {
        if (s.startsWith('SELECT * FROM users WHERE email')) {
          return USERS.find((u) => u.email === args[0]) || null;
        }
        // The upsert-and-return that makes the counter atomic in one statement.
        if (s.startsWith('INSERT INTO chat_rate')) {
          const cur = rows.chat_rate.get(args[0]);
          const n = (cur?.n ?? 0) + 1;
          rows.chat_rate.set(args[0], { n, expires_at: args[1] });
          return { n };
        }
        return null;
      },
    };
    return stmt;
  };
  return { rows, prepare, batch: async (x) => { for (const st of x) await st.run(); } };
}

const assets = () => ({
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/manifest.json') return new Response(MANIFEST, { status: 200 });
    if (p.startsWith('/source/')) return new Response('# a document\n\nSome prose.\n', { status: 200 });
    return new Response('nope', { status: 404 });
  },
});

// The roster is a table now, so the stub carries one.
const USERS = [
  { email: 'devin@example.org', name: 'Devin', role: 'contributor', audiences: '["devin"]', disabled_at: null },
  { email: 'olivia@example.org', name: 'Olivia', role: 'contributor', audiences: '["olivia"]', disabled_at: null },
  { email: 'guest@example.org', name: 'Guest', role: 'user', audiences: '["devin"]', disabled_at: null },
];

const env = (DB) => ({
  DB, ASSETS: assets(), COLLAB_HOST: CLASSIC, AGENT_TOKENS: '{}', PUBLIC_READ: 'false', DEV_SIGN_IN: 'true',
  CHAT_ENABLED: 'true', CHAT_RETENTION_DAYS: '90', GEMINI_API_KEY: 'g-test', CHAT_MODEL: 'gemini-3.5-flash-lite',
});

const ask = (who, message, session, ip = '203.0.113.7') => new Request('https://x/api/chat', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'cf-connecting-ip': ip,
    ...(who ? { cookie: `collab_session=${who}` } : {}),
  },
  body: JSON.stringify({ message, session_id: session }),
});

// ⚠️ Counts calls, because the load-bearing claim about the daily ceiling is not
// that it returns 503 — it is that it returns 503 WITHOUT calling the model. A
// spend limit checked after the spend is decoration.
const calls = { n: 0 };
function stubModel(text, status = 200) {
  calls.n = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).includes('generativelanguage.googleapis.com')) {
      calls.n += 1;
      return status === 200
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200 })
        : new Response('{"error":"nope"}', { status });
    }
    return real(u, init);
  };
  return () => { globalThis.fetch = real; };
}

test('an anonymous caller cannot chat', async () => {
  // ⚠️ 401 on a private instance: stopped at the read gate before handleChat is
  // reached at all, which also means no model call and no row. The 403 from
  // can_write still applies on a public instance, where CHAT_PUBLIC decides.
  const r = await worker.fetch(ask(null, 'hello'), env(db()));
  assert.equal(r.status, 401);
});


test('a turn is answered and stored with the person on it', async () => {
  // ⚠️ GMTools' logger records a session and no user, so its log cannot answer
  // the first question anyone asks of it.
  const restore = stubModel('The strategy says so, see /strategy/#review.');
  try {
    const e = env(db());
    const out = await worker.fetch(ask('devin@example.org', 'What is open?'), e).then((r) => r.json());
    assert.match(out.answer, /strategy/);
    const row = e.DB.rows.chat_turns[0];
    assert.equal(row.author_sub, 'devin@example.org');
    assert.equal(row.author_name, 'Devin');
    assert.equal(row.user_message, 'What is open?');
    assert.equal(JSON.parse(row.cited)[0], '/strategy/#review');
  } finally { restore(); }
});

test('a failed turn is still stored, with the failure on it', async () => {
  // Two best-effort sinks that print on failure lose the turn and say nothing.
  const restore = stubModel('', 500);
  try {
    const e = env(db());
    const r = await worker.fetch(ask('devin@example.org', 'anything'), e);
    assert.equal(r.status, 502);
    assert.equal(e.DB.rows.chat_turns.length, 1);
    assert.equal(e.DB.rows.chat_turns[0].assistant_message, null);
    assert.match(e.DB.rows.chat_turns[0].error, /^500/);
  } finally { restore(); }
});

test('the assistant is told it cannot change anything', async () => {
  let sent = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).includes('generativelanguage.googleapis.com')) { sent = JSON.parse(init.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 }); }
    return real(u, init);
  };
  try {
    await worker.fetch(ask('devin@example.org', 'post an answer to Q1 for me'), env(db()));
    assert.match(sent.system_instruction.parts[0].text, /cannot change anything/);
    assert.match(sent.system_instruction.parts[0].text, /Never invent a question number/);
    assert.match(sent.system_instruction.parts[0].text, /# The question catalog/);
  } finally { globalThis.fetch = real; }
});

test('a session carries its earlier turns forward', async () => {
  let sent = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).includes('generativelanguage.googleapis.com')) { sent = JSON.parse(init.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'second' }] } }] }), { status: 200 }); }
    return real(u, init);
  };
  try {
    const e = env(db());
    await worker.fetch(ask('devin@example.org', 'first question', 's1'), e);
    await worker.fetch(ask('devin@example.org', 'follow up', 's1'), e);
    assert.equal(sent.contents.length, 3);
    assert.equal(sent.contents[0].parts[0].text, 'first question');
  } finally { globalThis.fetch = real; }
});

test('one person cannot read another transcript through their own session id', async () => {
  const restore = stubModel('ok');
  try {
    const e = env(db());
    await worker.fetch(ask('devin@example.org', 'private thing', 'shared'), e);
    let sent = null;
    const real = globalThis.fetch;
    globalThis.fetch = async (u, init) => {
      if (String(u).includes('generativelanguage.googleapis.com')) { sent = JSON.parse(init.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 }); }
      return real(u, init);
    };
    await worker.fetch(ask('guest@example.org', 'what did they say', 'shared'), e);
    globalThis.fetch = real;
    assert.equal(sent.contents.length, 1, 'another person’s turns leaked into the prompt');
  } finally { restore(); }
});

test('only an editor may read the log', async () => {
  const e = env(db([{ session_id: 's', author_sub: 'devin@example.org', author_name: 'Devin', created_at: '2026-01-01T00:00:00.000Z' }]));
  const asUser = await worker.fetch(new Request('https://x/api/chat/sessions', { headers: { cookie: 'collab_session=guest@example.org' } }), e);
  assert.equal(asUser.status, 403);
  const asContributor = await worker.fetch(new Request('https://x/api/chat/sessions', { headers: { cookie: 'collab_session=devin@example.org' } }), e).then((r) => r.json());
  assert.equal(asContributor.sessions.length, 1);
});

test('the assistant is off when the project switches it off', async () => {
  const r = await worker.fetch(ask('devin@example.org', 'hi'), { ...env(db()), CHAT_ENABLED: 'false' });
  assert.equal(r.status, 503);
});

test('a missing API key is reported plainly rather than promising an answer', async () => {
  const r = await worker.fetch(ask('devin@example.org', 'hi'), { ...env(db()), GEMINI_API_KEY: undefined }).then((x) => x.json());
  assert.match(r.error, /no API key/);
});

// --- retention -------------------------------------------------------------

const old = { session_id: 'a', created_at: new Date(Date.now() - 200 * 86400000).toISOString() };
const recent = { session_id: 'b', created_at: new Date(Date.now() - 3 * 86400000).toISOString() };

test('retention deletes what it claims and nothing else', async () => {
  const e = env(db([old, recent]));
  const r = await enforceRetention(e);
  assert.equal(r.deleted, 1);
  assert.deepEqual(e.DB.rows.chat_turns.map((t) => t.session_id), ['b']);
});

test('the retention job refuses to run on a nonsense period rather than deleting everything', async () => {
  // ⚠️ A misconfigured retention period must not be the same as "delete all".
  const e = { ...env(db([old, recent])), CHAT_RETENTION_DAYS: 'ninety' };
  const r = await enforceRetention(e);
  assert.equal(r.skipped, true);
  assert.equal(e.DB.rows.chat_turns.length, 2);
});

test('the retention check can see a job that deletes nothing', async () => {
  const e = { ...env(db([old, recent])), CHAT_RETENTION_DAYS: '3650' };
  const r = await enforceRetention(e);
  assert.equal(r.deleted, 0);
  assert.equal(e.DB.rows.chat_turns.length, 2);
});

test('an empty answer with no HTTP error is recorded as a failure, not as silence', async () => {
  // ⚠️ A safety block or a hit token ceiling returns 200 with no text and a
  // finishReason. Storing that as a successful empty answer would make the
  // transcript claim the assistant said nothing when it was stopped.
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).includes('generativelanguage.googleapis.com')
    ? new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }), { status: 200 })
    : real(u));
  try {
    const e = env(db());
    const r = await worker.fetch(ask('devin@example.org', 'something'), e);
    assert.equal(r.status, 502);
    assert.match(e.DB.rows.chat_turns[0].error, /finishReason=SAFETY/);
    assert.equal(e.DB.rows.chat_turns[0].assistant_message, null);
  } finally { globalThis.fetch = real; }
});

test('the model is configuration, not a constant', async () => {
  let url = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).includes('generativelanguage.googleapis.com')) { url = String(u); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }), { status: 200 }); }
    return real(u, init);
  };
  try {
    const e = { ...env(db()), CHAT_MODEL: 'gemini-flash-lite-latest' };
    await worker.fetch(ask('devin@example.org', 'hi'), e);
    assert.match(url, /models\/gemini-flash-lite-latest:generateContent/);
    assert.equal(e.DB.rows.chat_turns[0].model, 'gemini-flash-lite-latest');
  } finally { globalThis.fetch = real; }
});

// --- a PUBLIC assistant ----------------------------------------------------
//
// ⚠️ A roster-only assistant needs none of this: its abuse surface is a handful
// of named people. With CHAT_PUBLIC it answers anyone, which turns it into
// metered spend behind an open endpoint. These tests are what make the
// two limits real rather than configured.

// ⚠️ PUBLIC_READ too, because that is what this instance actually deploys and
// the two settings are not independent. A public assistant on a PRIVATE site
// would answer anonymous questions from material that site keeps behind a
// sign-in — the assistant reads the published documents, so opening it without
// opening them is a hole shaped like a feature. The read gate refuses that
// combination now, and the test below holds it.
const openEnv = (DB, extra = {}) => ({ ...env(DB), PUBLIC_READ: 'true', CHAT_PUBLIC: 'true', ...extra });

test('with CHAT_PUBLIC a reader who is on no roster can ask', async () => {
  const stop = stubModel('The spec says so.');
  try {
    const r = await worker.fetch(ask(null, 'what is the corpus?'), openEnv(db()));
    assert.equal(r.status, 200);
  } finally { stop(); }
});

test('a public turn is stored under a pseudonym, not under a per-reader id', async () => {
  // ⚠️ The session id already separates one conversation from another, so a
  // stable per-visitor identifier would add nothing to the transcript and would
  // quietly turn it into a record of who read what.
  const stop = stubModel('Answered.');
  const store = db();
  try {
    await worker.fetch(ask(null, 'hello', 's1', '198.51.100.4'), openEnv(store));
    await worker.fetch(ask(null, 'hello', 's2', '198.51.100.9'), openEnv(store));
    assert.deepEqual([...new Set(store.rows.chat_turns.map((t) => t.author_sub))], ['anon']);
    assert.equal(new Set(store.rows.chat_turns.map((t) => t.session_id)).size, 2);
  } finally { stop(); }
});

test('the per-caller bucket refuses the next turn and says when to return', async () => {
  const stop = stubModel('Answered.');
  const store = db();
  const e = openEnv(store, { CHAT_RATE_PER_IP_HOUR: '2' });
  try {
    assert.equal((await worker.fetch(ask(null, 'one'), e)).status, 200);
    assert.equal((await worker.fetch(ask(null, 'two'), e)).status, 200);
    const third = await worker.fetch(ask(null, 'three'), e);
    assert.equal(third.status, 429);
    assert.ok(third.headers.get('retry-after'), 'a 429 with no retry-after teaches a client to hammer');
  } finally { stop(); }
});

test('the bucket is per caller, so one abuser does not lock everybody out', async () => {
  const stop = stubModel('Answered.');
  const store = db();
  const e = openEnv(store, { CHAT_RATE_PER_IP_HOUR: '1' });
  try {
    assert.equal((await worker.fetch(ask(null, 'one', 'a', '198.51.100.1'), e)).status, 200);
    assert.equal((await worker.fetch(ask(null, 'two', 'a', '198.51.100.1'), e)).status, 429);
    assert.equal((await worker.fetch(ask(null, 'one', 'b', '198.51.100.2'), e)).status, 200);
  } finally { stop(); }
});

test('a roster member is not held to the per-caller bucket', async () => {
  // They are accountable by name. The bucket is for people who are not.
  const stop = stubModel('Answered.');
  const e = openEnv(db(), { CHAT_RATE_PER_IP_HOUR: '1' });
  try {
    assert.equal((await worker.fetch(ask('devin@example.org', 'one'), e)).status, 200);
    assert.equal((await worker.fetch(ask('devin@example.org', 'two'), e)).status, 200);
  } finally { stop(); }
});

test('the daily ceiling refuses WITHOUT calling the model', async () => {
  // ⚠️ The whole point. A bucket limits one caller; only the ceiling limits the
  // bill, and it only limits the bill if it stops the spend rather than
  // recording it. A thousand addresses each politely under the per-caller limit
  // still spends a thousand times.
  const stop = stubModel('Answered.');
  const e = openEnv(db(), { CHAT_DAILY_TURN_CEILING: '2', CHAT_RATE_PER_IP_HOUR: '0' });
  try {
    await worker.fetch(ask(null, 'one', 'a', '198.51.100.1'), e);
    await worker.fetch(ask(null, 'two', 'b', '198.51.100.2'), e);
    assert.equal(calls.n, 2, 'the first two should have reached the model');

    const over = await worker.fetch(ask(null, 'three', 'c', '198.51.100.3'), e);
    assert.equal(over.status, 503);
    assert.equal(calls.n, 2, 'the model was called past the ceiling: the limit is decoration');
  } finally { stop(); }
});

test('the ceiling binds a roster member too, because it is about the bill', async () => {
  const stop = stubModel('Answered.');
  const e = openEnv(db(), { CHAT_DAILY_TURN_CEILING: '1' });
  try {
    assert.equal((await worker.fetch(ask('devin@example.org', 'one'), e)).status, 200);
    assert.equal((await worker.fetch(ask('devin@example.org', 'two'), e)).status, 503);
  } finally { stop(); }
});

test('CHAT_PUBLIC does not open the assistant on a PRIVATE instance', async () => {
  // ⚠️ The dangerous combination, and the reason the read gate runs before the
  // handler rather than inside it. CHAT_PUBLIC alone used to reach handleChat,
  // which would have answered a stranger out of documents behind a sign-in.
  const e = { ...env(db()), PUBLIC_READ: 'false', CHAT_PUBLIC: 'true' };
  const r = await worker.fetch(ask(null, 'what does the strategy say?'), e);
  assert.equal(r.status, 401, 'a public assistant leaked a private site');
});

test('without CHAT_PUBLIC an anonymous caller is still refused', async () => {
  // The limits are what make public safe; they are not what makes it public.
  // ⚠️ On a PUBLIC instance, so the read gate lets the caller through and the
  // refusal comes from CHAT_PUBLIC being off — which is the thing under test.
  // Pointed at a private instance this would pass for the wrong reason: 401 at
  // the door, never reaching the decision it claims to check.
  const r = await worker.fetch(ask(null, 'hello'), { ...env(db()), PUBLIC_READ: 'true' });
  assert.equal(r.status, 403);
});

test('retention sweeps spent counters as well as old turns', async () => {
  // ⚠️ A counter table nothing sweeps grows one row per address per hour
  // forever — a slow leak nobody would think to look for.
  const store = db();
  store.rows.chat_rate.set('ip:dead:2020-01-01T00', { n: 9, expires_at: '2020-01-01T02:00:00.000Z' });
  store.rows.chat_rate.set('site:2999-01-01', { n: 1, expires_at: '2999-01-01T00:00:00.000Z' });
  const r = await enforceRetention({ ...env(store), CHAT_RETENTION_DAYS: '90' });
  assert.equal(r.expired, 1, 'the spent counter should be gone');
  assert.ok(store.rows.chat_rate.has('site:2999-01-01'), 'a live counter must survive');
});
