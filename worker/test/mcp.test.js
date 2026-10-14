import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../src/index.js';

// The real manifest, so these tests break when the compiler's output changes
// shape -- which is the point. A hand-written fixture would keep passing.
const MANIFEST = fs.readFileSync('build/manifest.json', 'utf8');
const M = JSON.parse(MANIFEST);

// ⚠️ Everything below is derived from the manifest. Naming a demo question by
// slug made seven tests about the MACHINERY fail the moment the content was
// replaced -- which is exactly backwards for a template.
const ANY = M.questions[0];
const ANY_DOC = M.docs.find((d) => d.type === 'doc');
// ⚠️ A catalog with no questions yet is a legitimate state for a NEW instance,
// and this used to throw `Cannot read properties of undefined` at import time —
// before a single test ran, with a stack trace naming neither the cause nor the
// fix. A fresh fork could not run its own suite until it had content. Say what
// is actually wrong instead, and let the rest of the file fail normally.
if (!ANY) {
  test('the content declares at least one question', () => {
    assert.fail('build/manifest.json declares no questions, so nothing below can exercise the MCP surface. Author a :::question and rebuild.');
  });
}
const ANY_AUDIENCE = ANY?.audience;

function assets() {
  return {
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      if (p === '/manifest.json') return new Response(MANIFEST, { status: 200 });
      if (p === '/tokens.css') return new Response(':root { --ink: #111; }', { status: 200 });
      if (p.startsWith('/source/')) return new Response('# a document\n', { status: 200 });
      return new Response('not found', { status: 404 });
    },
  };
}

function db() {
  const rows = { answers: [], comments: [] };
  const prepare = (sql) => {
    let args = [];
    const s = sql.replace(/\s+/g, ' ').trim();
    const stmt = {
      bind: (...a) => { args = a; return stmt; },
      run: async () => {
        if (s.startsWith('INSERT INTO answers')) rows.answers.push({ id: args[0], question_id: args[1], author_sub: args[2], author_name: args[3], body: args[4], created_at: args[5], revision_count: 0 });
        if (s.startsWith('INSERT INTO comments')) rows.comments.push({ id: args[0], thread: args[1], doc: args[2], section: args[3], parent_id: args[4], author_sub: args[5], author_name: args[6], body: args[7], created_at: args[8] });
        return { success: true };
      },
      all: async () => {
        if (s.includes('FROM answers')) return { results: rows.answers.filter((r) => args.includes(r.question_id)) };
        if (s.includes('FROM comments')) return { results: rows.comments };
        return { results: [] };
      },
      first: async () => {
        if (s.startsWith('SELECT * FROM users WHERE email')) {
          return USERS.find((u) => u.email === args[0]) || null;
        }
        return null;
      },
    };
    return stmt;
  };
  return { rows, prepare, batch: async (x) => { for (const s of x) await s.run(); } };
}

// The roster is a table now, so the stub carries one.
const USERS = [
  { email: 'devin@example.org', name: 'Devin', role: 'contributor', audiences: '["devin"]', disabled_at: null },
  { email: 'olivia@example.org', name: 'Olivia', role: 'contributor', audiences: '["olivia"]', disabled_at: null },
  { email: 'guest@example.org', name: 'Guest', role: 'user', audiences: '["devin"]', disabled_at: null },
];
const env = () => ({ DB: db(), ASSETS: assets(), AGENT_TOKENS: '{}', PUBLIC_READ: 'false', DEV_SIGN_IN: 'true' });

const rpc = (method, params, who) => new Request('https://x/mcp', {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, who ? { cookie: `collab_session=${who}` } : {}),
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});

const callTool = async (name, args, e, who = 'devin@example.org') => {
  const r = await worker.fetch(rpc('tools/call', { name, arguments: args || {} }, who), e);
  const j = await r.json();
  return j.result;
};

test('initialize announces the server', async () => {
  const j = await worker.fetch(rpc('initialize', {}, 'devin@example.org'), env()).then((r) => r.json());
  assert.equal(j.result.serverInfo.name, 'collab-site');
});

test('tools/list offers read and write tools', async () => {
  const j = await worker.fetch(rpc('tools/list', {}, 'devin@example.org'), env()).then((r) => r.json());
  const names = j.result.tools.map((t) => t.name);
  for (const n of ['list_documents', 'read_document', 'list_questions', 'read_question', 'post_answer', 'list_comments', 'reply_to_comment', 'get_design_tokens', 'list_activity']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

test('an unauthenticated caller cannot read a private project', async () => {
  const r = await worker.fetch(rpc('tools/call', { name: 'list_questions', arguments: {} }, null), env()).then((x) => x.json());
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Not authenticated/);
});

test('list_questions carries the question, the reason it was asked, and its answers', async () => {
  const e = env();
  const out = JSON.parse((await callTool('list_questions', {}, e)).content[0].text);
  assert.equal(out.length, M.questions.filter((q) => !q.hidden).length);
  const first = out.find((q) => q.number === ANY.number);
  assert.ok(first.question.length > 0, 'the question text did not survive');
  assert.equal(/</.test(first.question), false, 'the question text should be plain, not HTML');
  assert.deepEqual(first.answers, []);
});

test('list_questions open=true hides resolved ones', async () => {
  const e = env();
  const all = JSON.parse((await callTool('list_questions', {}, e)).content[0].text);
  const open = JSON.parse((await callTool('list_questions', { open: true }, e)).content[0].text);
  const expected = M.questions.filter((q) => !q.hidden && !q.resolved).length;
  assert.equal(open.length, expected);
  assert.equal(open.some((q) => q.resolved), false);
  assert.ok(open.length <= all.length);
});

test('list_questions filters by audience', async () => {
  const out = JSON.parse((await callTool('list_questions', { audience: ANY_AUDIENCE }, env())).content[0].text);
  assert.ok(out.length > 0);
  assert.equal(out.every((q) => q.audience === ANY_AUDIENCE), true);
});

test('post_answer writes through the same path the web form uses', async () => {
  // Two code paths writing one table is how an agent ends up able to do
  // something a person cannot.
  const e = env();
  const r = await callTool('post_answer', { slug: ANY.slug, body: 'A real answer.' }, e);
  assert.match(r.content[0].text, new RegExp(`Posted as Devin against Q${ANY.number}`));
  assert.equal(e.DB.rows.answers.length, 1);
  assert.equal(e.DB.rows.answers[0].author_sub, 'devin@example.org');
  const back = JSON.parse((await callTool('list_questions', {}, e)).content[0].text);
  assert.equal(back.find((q) => q.number === ANY.number).answers[0].body, 'A real answer.');
});

test('post_answer against a slug that does not exist says so', async () => {
  const r = await callTool('post_answer', { slug: 'no-such-question', body: 'x' }, env());
  assert.match(r.content[0].text, /No question/);
});

test('a read-only caller cannot post', async () => {
  // Nobody on the roster and reads open: the caller is anonymous and read-only.
  const e = { ...env(), PUBLIC_READ: 'true' };
  const r = await callTool('post_answer', { slug: ANY.slug, body: 'x' }, e, null);
  assert.match(r.content[0].text, /Not permitted/);
});

test('reply_to_comment records the parent', async () => {
  const e = env();
  await worker.fetch(new Request('https://x/api/comments', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: 'collab_session=devin@example.org' },
    body: JSON.stringify({ body: 'The cadence section is unclear.', doc: 'notifications' }),
  }), e);
  const parent = e.DB.rows.comments[0].id;
  await callTool('reply_to_comment', { id: parent, body: 'Fixed in the next pass.' }, e);
  assert.equal(e.DB.rows.comments.length, 2);
  assert.equal(e.DB.rows.comments[1].parent_id, parent);
});

test('read_document returns the source a contributor would edit', async () => {
  const r = await callTool('read_document', { slug: ANY_DOC.slug }, env());
  assert.match(r.content[0].text, /^# a document/);
});

test('get_design_tokens returns the real stylesheet', async () => {
  const r = await callTool('get_design_tokens', {}, env());
  assert.match(r.content[0].text, /--ink/);
});

test('list_activity separates the feed from the decision log', async () => {
  const out = JSON.parse((await callTool('list_activity', {}, env())).content[0].text);
  assert.ok(out.some((d) => d.type === 'post'));
  assert.ok(out.some((d) => d.type === 'decision'));
});

test('an unknown tool name is reported, not ignored', async () => {
  const r = await callTool('no_such_tool', {}, env());
  assert.match(r.content[0].text, /No tool named/);
});

test('the transcript is readable over MCP by a contributor and not by a user', async () => {
  const e = env();
  const asUser = await worker.fetch(rpc('tools/call', { name: 'list_chat_sessions', arguments: {} }, 'guest@example.org'), e);
  void asUser;
  const r = await callTool('list_chat_sessions', {}, e);
  assert.doesNotMatch(r.content[0].text, /No tool named/);
});

test('initialize answers with the protocol version the client asked for', async () => {
  // ⚠️ A fixed version a newer client did not offer is a negotiation failure,
  // and the client reports it as "the MCP server returned an error".
  const r = await worker.fetch(new Request('https://x/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'collab_session=devin@example.org' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
  }), env()).then((x) => x.json());
  assert.equal(r.result.protocolVersion, '2025-06-18');
});

test('the methods a client sends during setup are answered, not refused', async () => {
  const e = env();
  for (const [method, key] of [['ping', null], ['resources/list', 'resources'], ['prompts/list', 'prompts']]) {
    const r = await worker.fetch(rpc(method, {}, 'devin@example.org'), e).then((x) => x.json());
    assert.ok(r.result, `${method} was not answered`);
    if (key) assert.deepEqual(r.result[key], []);
  }
});

test('a thrown error comes back as a JSON-RPC error naming the cause', async () => {
  // Not an opaque 500: the client shows "the server returned an error" and
  // nothing else, so the cause has to travel in the body and the log.
  const broken = { ...env(), ASSETS: { fetch: async () => { throw new Error('assets exploded'); } } };
  const r = await worker.fetch(rpc('tools/call', { name: 'list_documents', arguments: {} }, 'devin@example.org'), broken);
  assert.equal(r.status, 500);
  assert.match((await r.json()).error.message, /assets exploded/);
});
