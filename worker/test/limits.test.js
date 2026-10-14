// One bound, every door that stores somebody's words.
//
// ⚠️ These are written per DOOR rather than per function on purpose. The
// invariant is "the API and the MCP tools share one write path", and the way
// that invariant fails is a second path — so a test that called `createAnswer`
// directly would pass while an unbounded route sat next to it. Each test below
// goes in through the same surface a person or an agent actually uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../src/index.js';
import { MAX_BODY, overLimit } from '../src/limits.js';

const MANIFEST = fs.readFileSync('build/manifest.json', 'utf8');
const M = JSON.parse(MANIFEST);
const ANY = M.questions[0];

function db() {
  const rows = { answers: [], answer_revisions: [], comments: [], chat_turns: [] };
  const prepare = (sql) => {
    let args = [];
    const s = sql.replace(/\s+/g, ' ').trim();
    const stmt = {
      bind: (...a) => { args = a; return stmt; },
      run: async () => {
        if (s.startsWith('INSERT INTO answers')) rows.answers.push({ id: args[0], question_id: args[1], author_sub: args[2], body: args[4], revision_count: 0 });
        if (s.startsWith('INSERT INTO answer_revisions')) rows.answer_revisions.push({ answer_id: args[1], body: args[2] });
        if (s.startsWith('INSERT INTO comments')) rows.comments.push({ id: args[0], body: args[7] });
        if (s.startsWith('INSERT INTO chat_turns')) rows.chat_turns.push({ id: args[0], user_message: args[5] });
        if (s.startsWith('UPDATE answers SET body')) {
          const a = rows.answers.find((r) => r.id === args[2]);
          if (a) { a.body = args[0]; a.revision_count += 1; }
        }
        return { success: true };
      },
      all: async () => ({ results: [] }),
      first: async () => {
        if (s.startsWith('SELECT * FROM users WHERE email')) return USERS.find((u) => u.email === args[0]) || null;
        if (s.startsWith('SELECT * FROM answers')) return rows.answers.find((r) => r.id === args[0]) || null;
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
    if (p.startsWith('/source/')) return new Response('# a document\n', { status: 200 });
    return new Response('not found', { status: 404 });
  },
});

const USERS = [
  { email: 'devin@example.org', name: 'Devin', role: 'contributor', audiences: '["devin"]', disabled_at: null },
];

const env = (DB = db()) => ({
  DB, ASSETS: assets(), AGENT_TOKENS: '{}', PUBLIC_READ: 'false', DEV_SIGN_IN: 'true',
  CHAT_ENABLED: 'true', CHAT_RETENTION_DAYS: '90', GEMINI_API_KEY: 'g-test',
});

const WHO = 'devin@example.org';
const api = (path, method, body) => new Request('https://x' + path, {
  method,
  headers: { 'content-type': 'application/json', cookie: `collab_session=${WHO}` },
  body: JSON.stringify(body),
});
const rpc = (name, args) => new Request('https://x/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `collab_session=${WHO}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
});

// One character past the limit. Building it from MAX_BODY rather than from a
// literal means raising the limit does not quietly stop testing it.
const TOO_LONG = 'x'.repeat(MAX_BODY + 1);
const JUST_FITS = 'y'.repeat(MAX_BODY);

test('the limit answers at its own edge', () => {
  // ⚠️ An off-by-one here is the difference between a bound and a bound that
  // refuses the longest legitimate answer somebody ever writes.
  assert.equal(overLimit(JUST_FITS), null);
  assert.ok(overLimit(TOO_LONG));
  assert.match(overLimit(TOO_LONG), new RegExp(String(MAX_BODY)), 'the refusal must say what the limit is');
  assert.match(overLimit(TOO_LONG), /Nothing was saved/, 'the refusal must say the words were not stored');
});

test('an over-long answer is refused and nothing is stored', async () => {
  const e = env();
  const r = await worker.fetch(api('/api/answers', 'POST', { question_id: ANY.id, body: TOO_LONG }), e);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /too long/);
  assert.equal(e.DB.rows.answers.length, 0, 'a refused answer must not be half-written');
});

test('an over-long EDIT is refused and the answer is left alone', async () => {
  // ⚠️ The create path and the edit path store the same column. Bounding one
  // and not the other leaves a door open that looks closed.
  const e = env();
  await worker.fetch(api('/api/answers', 'POST', { question_id: ANY.id, body: 'short' }), e);
  const id = e.DB.rows.answers[0].id;
  const r = await worker.fetch(api(`/api/answers/${id}`, 'PATCH', { body: TOO_LONG }), e);
  assert.equal(r.status, 400);
  assert.equal(e.DB.rows.answers[0].body, 'short');
  assert.equal(e.DB.rows.answer_revisions.length, 0, 'a refused edit must not open a revision');
});

test('an over-long comment is refused and nothing is stored', async () => {
  const e = env();
  const r = await worker.fetch(api('/api/comments', 'POST', { body: TOO_LONG }), e);
  assert.equal(r.status, 400);
  assert.equal(e.DB.rows.comments.length, 0);
});

test('an agent gets the same refusal a person does', async () => {
  // The whole reason the write paths are shared: an agent must not be able to
  // store something a person cannot.
  const e = env();
  const answer = await worker.fetch(rpc('post_answer', { slug: ANY.slug, body: TOO_LONG }), e).then((r) => r.json());
  assert.match(JSON.stringify(answer.result), /too long/);
  assert.equal(e.DB.rows.answers.length, 0);

  const comment = await worker.fetch(rpc('reply_to_comment', { id: 'c1', body: TOO_LONG }), e).then((r) => r.json());
  assert.match(JSON.stringify(comment.result), /too long/);
  assert.equal(e.DB.rows.comments.length, 0);
});

test('an over-long chat turn is refused before the model is called', async () => {
  // ⚠️ This is the one path that spends money on somebody else's
  // infrastructure, so the refusal has to happen before the request goes out.
  const real = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (u, init) => {
    if (String(u).includes('generativelanguage.googleapis.com')) { called = true; return new Response('{}', { status: 200 }); }
    return real(u, init);
  };
  try {
    const e = env();
    const r = await worker.fetch(api('/api/chat', 'POST', { message: TOO_LONG }), e);
    assert.equal(r.status, 400);
    assert.equal(called, false, 'the model was called with a body that was going to be refused');
    assert.equal(e.DB.rows.chat_turns.length, 0);
  } finally { globalThis.fetch = real; }
});

test('a body at the limit still goes through', async () => {
  // ⚠️ The failure mode of a bound is a bound that refuses real work. Both
  // directions are tested, or this file only proves that writing can fail.
  const e = env();
  const r = await worker.fetch(api('/api/answers', 'POST', { question_id: ANY.id, body: JUST_FITS }), e);
  assert.equal(r.status, 201);
  assert.equal(e.DB.rows.answers[0].body.length, MAX_BODY);
});
