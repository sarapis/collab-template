import { matches } from './routes.js';
import { identify, ANON, canRead } from './identity.js';
import { handleMcp } from './mcp.js';
import { handleAuth } from './auth.js';
import { PUBLIC_NOTICE } from './site.generated.js';

// Everything the sign-in page needs, and nothing else.
const PUBLIC_ASSETS = new Set(['/tokens.css']);
import { flag } from './flag.js';
import { overLimit } from './limits.js';
import { handleChat, listSessions, readSession, enforceRetention } from './chat.js';
import { handleAdmin } from './admin.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

// --- handlers --------------------------------------------------------------

async function getAnswers(request, env, me) {
  const ids = (new URL(request.url).searchParams.get('q') || '').split(',').filter(Boolean);
  if (!ids.length) return json({ answers: {} });
  const marks = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, question_id, author_sub, author_name, body, created_at, updated_at, revision_count
       FROM answers WHERE question_id IN (${marks}) ORDER BY created_at`
  ).bind(...ids).all();

  const answers = {};
  for (const r of results || []) {
    (answers[r.question_id] ||= []).push({
      id: r.id, body: r.body, author_name: r.author_name,
      created_at: r.created_at, edited_at: r.updated_at,
      revision_count: r.revision_count, mine: !!me.sub && r.author_sub === me.sub,
    });
  }
  return json({ answers });
}

async function postAnswer(request, env, me) {
  if (!me.can_write) return json({ error: 'not permitted' }, 403);
  const body = await readBody(request);
  if (!body?.question_id) return json({ error: 'question_id and body required' }, 400);
  const r = await createAnswer(body.question_id, body.body, env, me);
  return r.ok ? json({ id: r.id }, 201) : json({ error: r.error }, 400);
}

async function patchAnswer(request, env, me, answerId) {
  if (!me.can_write) return json({ error: 'not permitted' }, 403);
  const body = await readBody(request);
  const text = String(body?.body || '').trim();
  if (!text) return json({ error: 'body required' }, 400);
  // ⚠️ An edit stores a body exactly as a post does. Bounding only the create
  // path would leave one door open and look closed.
  const long = overLimit(text);
  if (long) return json({ error: long }, 400);

  const existing = await env.DB.prepare('SELECT * FROM answers WHERE id = ?').bind(answerId).first();
  if (!existing) return json({ error: 'no such answer' }, 404);
  // Only the author. Contributors do not redact other people's words.
  if (existing.author_sub !== me.sub) return json({ error: 'not yours' }, 403);
  if (existing.body === text) return json({ id: answerId, unchanged: true });

  // The previous text is kept before the new text lands, so a correction is
  // always recoverable and always visible as one.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO answer_revisions (id, answer_id, body, replaced_at) VALUES (?, ?, ?, ?)')
      .bind(id(), answerId, existing.body, now()),
    env.DB.prepare('UPDATE answers SET body = ?, updated_at = ?, revision_count = revision_count + 1 WHERE id = ?')
      .bind(text, now(), answerId),
  ]);
  return json({ id: answerId });
}

async function getComments(request, env) {
  const p = new URL(request.url).searchParams;
  return json({ comments: await readComments(env, p.get('doc'), p.get('since')) });
}

async function postComment(request, env, me) {
  if (!me.can_write) return json({ error: 'not permitted' }, 403);
  const b = await readBody(request);
  const r = await createComment({ body: b?.body, doc: b?.doc || null, section: b?.section || null,
    parent: b?.parent_id || null, thread: String(b?.thread || 'general') }, env, me);
  return r.ok ? json({ id: r.id }, 201) : json({ error: r.error }, 400);
}

// What is waiting, for this person, right now.
//
// ⚠️ "Waiting for you" means a question YOU have not answered -- not one that is
// unresolved. Those are different states and conflating them made the count
// useless: eight answers were posted and the number did not move, because
// `resolved` is set by a contributor folding the answer into the prose, which is
// a different person doing a different job.
//
// ⚠️ TWO NUMBERS, and they are not the same number. `count` is what is
// outstanding and `unseen` is what is new since this person last opened the
// feed. The PAGE shows `count`, because the backlog is the honest state. The
// BADGE shows the sum of `unseen`, because an alert that is always lit is not an
// alert -- a standing count of ten reads as ten new things every time you look
// at it, and after a week you stop looking.
//
// `last_seen` exists ONLY for this, and never reaches the worksheet: the
// worksheet stays the same page for everyone.
async function getNotifications(request, env, me) {
  if (!me.authenticated) return json({ items: [], total: 0 });

  const seen = await env.DB.prepare('SELECT last_seen_at FROM seen WHERE sub = ?').bind(me.sub).first();
  const since = seen?.last_seen_at || '1970-01-01T00:00:00.000Z';

  const manifest = await env.ASSETS?.fetch(new Request(new URL('/manifest.json', request.url)))
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);

  const { results: answerRows } = await env.DB.prepare(
    'SELECT question_id, author_sub, MAX(created_at) AS latest FROM answers GROUP BY question_id, author_sub').all();

  // ⚠️ An answer written BEFORE the round a question is now in was an answer to
  // an earlier version of it. Treating "has an answer" as terminal meant a
  // reworded question stayed answered forever: two questions were rewritten
  // after "not sure what this means", and neither came back to the person they
  // were addressed to.
  const roundOpened = (q) => manifest?.asked_rounds?.[q.asked]?.opened || '1970-01-01T00:00:00.000Z';
  const currentFor = (rows, q) => rows.some((r) => r.question_id === q.id && r.latest >= roundOpened(q));

  const mineRows = (answerRows || []).filter((r) => r.author_sub === me.sub);
  const answeredByMe = (q) => currentFor(mineRows, q);
  const answeredByAnyone = (q) => currentFor(answerRows || [], q);

  const items = [];
  const open = (manifest?.questions || []).filter((q) => !q.resolved && !q.hidden);

  const mine = open.filter((q) => me.audiences.includes(q.audience) && !answeredByMe(q));
  if (mine.length) {
    const fresh = mine.filter((q) => manifest.asked_rounds?.[q.asked]?.new).length;
    // ⚠️ A question counts as unseen while the round that asked it is newer than
    // your last look. That is what makes REWORDING work: moving a question to a
    // new round opens it after your last visit, so it alerts again -- which is
    // the whole reason rounds carry a date.
    items.push({
      kind: 'waiting', forYou: true, count: mine.length, href: '/questions/?open=1',
      unseen: mine.filter((q) => roundOpened(q) > since).length,
      text: `${mine.length} question${mine.length === 1 ? '' : 's'} waiting for you`,
      detail: fresh
        ? `${fresh} reworded or newly asked since you last answered — an earlier answer is still on the record`
        : null,
    });
  }

  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE created_at > ? AND author_sub != ?')
    .bind(since, me.sub).first();
  if (c?.n) {
    items.push({
      kind: 'comments', forYou: true, count: c.n, unseen: c.n, href: '/summary/',
      text: `${c.n} new comment${c.n === 1 ? '' : 's'}`,
      detail: 'Someone said something nobody asked about.',
    });
  }

  if (me.role === 'contributor') {
    // The other half of the loop, and the half that stalls silently: an answer
    // that has landed and not yet been folded into the prose.
    const toFold = open.filter((q) => answeredByAnyone(q));
    if (toFold.length) {
      // Only an answer written since your last look is news. The backlog stays
      // in `count` and stays on the page; it just stops being an alarm.
      const freshlyAnswered = toFold.filter((q) => (answerRows || []).some((r) => r.question_id === q.id && r.latest > since)).length;
      items.push({
        kind: 'fold', forYou: false, count: toFold.length, href: '/questions/',
        unseen: freshlyAnswered,
        text: freshlyAnswered
          ? `${freshlyAnswered} new answer${freshlyAnswered === 1 ? '' : 's'} ready to fold into the prose`
          : `${toFold.length} answer${toFold.length === 1 ? '' : 's'} ready to fold into the prose`,
        detail: freshlyAnswered && freshlyAnswered !== toFold.length
          ? `${toFold.length} outstanding in total. Resolve each one in the commit that folds it in.`
          : 'Resolve each one in the commit that folds it in.',
      });
    }

    const waitingOnOthers = open.filter((q) => !answeredByAnyone(q) && !me.audiences.includes(q.audience));
    if (waitingOnOthers.length) {
      const who = [...new Set(waitingOnOthers.map((q) => manifest.audiences?.[q.audience]?.name || q.audience))];
      items.push({
        // Somebody else's backlog is a standing state, never news.
        kind: 'others', forYou: false, count: waitingOnOthers.length, unseen: 0, href: '/questions/?open=1',
        text: `${waitingOnOthers.length} waiting on ${who.join(', ')}`,
        detail: null,
      });
    }

    const chat = await env.DB.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM chat_turns WHERE created_at > ?')
      .bind(since).first();
    if (chat?.n) {
      items.push({
        kind: 'chat', forYou: false, count: chat.n, unseen: chat.n, href: '/chat/log/',
        text: `${chat.n} new conversation${chat.n === 1 ? '' : 's'} with the assistant`,
        detail: 'What people ask is the best evidence of what these documents fail to say.',
      });
    }
  }

  return json({ items, total: items.reduce((n, i) => n + (i.unseen || 0), 0) });
}

// ⚠️ First write wins. `ON CONFLICT DO NOTHING` keeps the original timestamp,
// so this records when somebody was first oriented rather than when they last
// wandered back through the page.
async function markStartSeen(env, sub) {
  await env.DB.prepare('INSERT INTO start_seen (sub, at) VALUES (?, ?) ON CONFLICT(sub) DO NOTHING')
    .bind(sub, now()).run();
}

async function hasSeenStart(env, sub) {
  const row = await env.DB.prepare('SELECT at FROM start_seen WHERE sub = ?').bind(sub).first().catch(() => null);
  return !!row?.at;
}

async function postSeen(request, env, me) {
  if (!me.authenticated) return json({ ok: false }, 401);
  await env.DB.prepare('INSERT INTO seen (sub, last_seen_at) VALUES (?, ?) ON CONFLICT(sub) DO UPDATE SET last_seen_at = excluded.last_seen_at')
    .bind(me.sub, now()).run();
  return json({ ok: true });
}

// --- shared write paths ----------------------------------------------------
// The API and the MCP tools call the SAME functions. Two code paths writing the
// same table is how an agent ends up able to do something a person cannot, or
// to skip a rule nobody remembered was only in the other one.

async function createAnswer(questionId, body, env, me) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'body required' };
  const long = overLimit(text);
  if (long) return { ok: false, error: long };
  if (!me.can_write) return { ok: false, error: 'not permitted' };
  const rowId = id();
  await env.DB.prepare(
    `INSERT INTO answers (id, question_id, author_sub, author_name, body, created_at, revision_count)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).bind(rowId, String(questionId), me.sub, me.name, text, now()).run();
  return { ok: true, id: rowId };
}

async function createComment({ body, doc = null, section = null, parent = null, thread = 'general' }, env, me) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'body required' };
  const long = overLimit(text);
  if (long) return { ok: false, error: long };
  if (!me.can_write) return { ok: false, error: 'not permitted' };
  const rowId = id();
  await env.DB.prepare(
    'INSERT INTO comments (id, thread, doc, section, parent_id, author_sub, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(rowId, thread, doc, section, parent, me.sub, me.name, text, now()).run();
  return { ok: true, id: rowId };
}

async function readComments(env, doc, since) {
  let q;
  if (doc) q = env.DB.prepare('SELECT * FROM comments WHERE doc = ? OR doc IS NULL ORDER BY created_at').bind(doc);
  else if (since) q = env.DB.prepare('SELECT * FROM comments WHERE created_at > ? ORDER BY created_at').bind(since);
  else q = env.DB.prepare('SELECT * FROM comments ORDER BY created_at');
  const { results } = await q.all();
  return results || [];
}

export const MCP_HANDLERS = {
  postAnswer: (qid, body, env, me) => createAnswer(qid, body, env, me),
  listComments: (env, doc, since) => readComments(env, doc, since),
  replyToComment: (parentId, body, env, me) => createComment({ body, parent: parentId }, env, me),
  // The transcript is contributor-only over MCP for the same reason it is on the
  // web: it is other people's unedited words about things not yet decided.
  listChatSessions: (env, me) => listSessions(env, me).then((r) => r.json()),
  readChatSession: (env, me, id) => readSession(env, me, id).then((r) => r.json()),
};

// --- entry -----------------------------------------------------------------

// The site itself: pages, the API, /mcp with a per-person bearer token, sign-in.
//
// ⚠️ This module must not import the OAuth provider. That package imports
// `cloudflare:workers`, which Node cannot load, and every test in this suite
// imports this file. The provider is wired in entry.js, which only the deploy
// loads. The default export here is the site alone, so a test exercises the
// same handler the site runs.
export const siteHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    // ⚠️ Served BEFORE the auth check. Its contents come from named config
    // fields, never from the manifest, so a new document cannot quietly become
    // public by existing.
    if (url.pathname === '/llms.txt') {
      if (!PUBLIC_NOTICE) return new Response('Not found', { status: 404 });
      return new Response(PUBLIC_NOTICE, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    // ⚠️ The sign-in page is public, so anything it LOADS has to be public too.
    // tokens.css sat behind the auth check, so a visitor who had not signed in
    // got a 302 for the stylesheet and an entirely unstyled page -- and the
    // failure was invisible to anyone already signed in, which is everyone who
    // was looking at it. The design system carries colours and type and no
    // content, so publishing it gives nothing away.
    if (PUBLIC_ASSETS.has(url.pathname)) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('no assets bound', { status: 500 });
    }

    if (url.pathname.startsWith('/auth/')) return handleAuth(request, env, url);

    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      const who = await identify(request, env).catch(() => ANON);
      return handleMcp(request, env, who, MCP_HANDLERS);
    }

    if (!url.pathname.startsWith('/api/')) {
      // The Worker serves the built site too: one origin, one auth check, and
      // no second copy of anything to drift.
      let me = null;
      if (!flag(env, 'PUBLIC_READ')) {
        me = await identify(request, env);
        // Same predicate as /api/ and MCP; see identity.js `canRead`.
        // A 401 with no way forward is what makes people paste passwords to
        // each other. Send them to the sign-in page, and bring them back to
        // the page they asked for.
        if (!me.authenticated) {
          return new Response(null, { status: 302, headers: { location: `/auth/login?next=${encodeURIComponent(url.pathname + url.search)}` } });
        }
      }

      // ⚠️ `/` is a router and not a page. The orientation page earns somebody's
      // attention exactly once; after that it is in the way, and the thing a
      // returning reader wants is where the project stands. The brand link on
      // every page points here, so this is the one decision that has to be
      // right.
      //
      // Server-side, and from D1, for two reasons: the redirect happens before
      // anything renders, so there is no flash of the wrong page, and it works
      // with JavaScript off -- the widget is additive and must never be what
      // decides where you land.
      if (url.pathname === '/') {
        const seen = me?.authenticated ? await hasSeenStart(env, me.sub) : false;
        return new Response(null, { status: 302, headers: { location: seen ? '/summary/' : '/start/', 'cache-control': 'no-store' } });
      }

      // Being served the page IS having seen it. ⚠️ Not a widget callback: with
      // no JavaScript that write would never happen and /start/ would be the
      // home page forever, which looks like the feature working.
      if (url.pathname === '/start/' && request.method === 'GET' && me?.authenticated) {
        await markStartSeen(env, me.sub).catch(() => {});
      }

      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('no assets bound', { status: 500 });
    }

    if (!matches(url.pathname)) return json({ error: 'no such route' }, 404);

    const me = await identify(request, env).catch(() => ANON);
    const m = request.method.toUpperCase();
    const p = url.pathname;

    // ⚠️ DEFAULT CLOSED, and BEFORE the dispatch below rather than inside each
    // handler. Every route added underneath is gated without anybody having to
    // remember to gate it — which is the failure this replaces: the page branch
    // above and the MCP door both refused an anonymous reader on a private
    // instance, and this branch did not, so `GET /api/answers?q=…` returned
    // people's words to anybody who asked.
    //
    // ⚠️ 401 rather than the 302 the page branch sends. A redirect to a sign-in
    // page is the right answer for a browser asking for a document and the
    // wrong one for a fetch() expecting JSON, which would parse the HTML as a
    // failure it cannot explain.
    //
    // /api/me is the single exemption, because it IS the anonymous shape: it
    // answers "who am I" with `authenticated: false` and nothing else, and the
    // widget needs that answer before it knows whether to show a sign-in link.
    if (!canRead(env, me) && p !== '/api/me') return json({ error: 'not signed in' }, 401);

    if (p === '/api/me' && m === 'GET') return json(me);
    if (p === '/api/answers' && m === 'GET') return getAnswers(request, env, me);
    if (p === '/api/answers' && m === 'POST') return postAnswer(request, env, me);
    if (p.startsWith('/api/answers/') && m === 'PATCH') return patchAnswer(request, env, me, p.split('/')[3]);
    if (p === '/api/comments' && m === 'GET') return getComments(request, env);
    if (p === '/api/comments' && m === 'POST') return postComment(request, env, me);
    if (p === '/api/notifications' && m === 'GET') return getNotifications(request, env, me);
    if (p === '/api/seen' && m === 'POST') return postSeen(request, env, me);
    if (p.startsWith('/api/admin/')) return handleAdmin(request, env, me, url);
    if (p === '/api/chat' && m === 'POST') return handleChat(request, env, me);
    if (p === '/api/chat/sessions' && m === 'GET') return listSessions(env, me);
    if (p.startsWith('/api/chat/sessions/') && m === 'GET') return readSession(env, me, p.split('/')[4]);

    return json({ error: 'method not allowed' }, 405);
  },
};

export default siteHandler;
