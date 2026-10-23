// The chatbot, and the transcript it produces.
//
// ⚠️ The bot NEVER writes to the repo, the question catalog or the answer store.
// It answers from what is already published here, and every turn is stored so
// the team and the team's Claude can read what was asked. The transcript is the
// feature; the bot is how it gets produced.
//
// What a user asks is a direct measurement of what the documents fail to say.
// That is why the log is worth more than the answers: it reaches the catalog as
// a pull request a contributor opens after reading it, not as something a bot
// wrote into a store nobody reviewed.

import { viewEnv } from './band.js';
import { flag } from './flag.js';
import { secretValue } from './secrets.js';
import { overLimit } from './limits.js';
import { waitsOn } from './waits.js';
import { isEditor } from './identity.js';

// The model is a var, not a constant, so changing it is a config edit and a
// deploy rather than a code change. ⚠️ Google renames these aliases; if the API
// starts returning 404 for the model, that is what happened -- set CHAT_MODEL
// to a name the account can see rather than editing this file.
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const MAX_CONTEXT = 120_000; // characters, not tokens: a coarse guard, not a budget

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    // `retry-after` on a 429 is the difference between a client that backs off
    // and a client that hammers a limit it cannot see.
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });

async function asset(env, request, path) {
  if (!env.ASSETS) return null;
  const r = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  return r.ok ? r : null;
}

// Everything the bot is allowed to know: the documents, the questions with
// their reasons, the activity feed and the decision log. Nothing else -- it has
// no access to answers, comments or other people's transcripts.
async function buildContext(env, request) {
  const m = await asset(env, request, '/manifest.json').then((r) => (r ? r.json() : null));
  if (!m) return null;

  const parts = [`# ${m.project?.name || 'This project'}`];
  if (m.project?.tagline) parts.push(m.project.tagline);

  for (const doc of m.docs) {
    const r = await asset(env, request, `/source/${doc.source}`);
    if (!r) continue;
    parts.push(`\n\n---\n\n# Document: ${doc.title} (/${doc.slug}/)\n\n${await r.text()}`);
    if (parts.join('').length > MAX_CONTEXT) break;
  }

  parts.push('\n\n---\n\n# The question catalog\n');
  for (const q of m.questions) {
    const state = q.resolved ? `resolved, see ${q.resolved}` : 'open';
    parts.push(`Q${q.number} (${q.slug}, for ${waitsOn(q).join(', ')}, ${state}): ${q.body.replace(/<[^>]+>/g, '').trim()}`);
    if (q.why) parts.push(`  Why asked: ${q.why.replace(/<[^>]+>/g, '').trim()}`);
  }

  return parts.join('\n').slice(0, MAX_CONTEXT);
}

const SYSTEM = `You answer questions about this project from the material below, for someone who has signed in to read it.

Rules:
- Answer only from the material. If it does not say, say that it does not say, and name the question number that covers it if one does.
- Never invent a question number, a date, a name or a figure.
- Point at the document and section you are drawing from, as a path like /strategy/#review.
- You cannot change anything: you cannot answer a question on somebody's behalf, post a comment, or edit a document. If asked to, say so and point at how a person does it (/editing/).
- Be brief. This is a working document, not a brochure.`;

// --- rate limiting for a PUBLIC assistant ----------------------------------
//
// ⚠️ A roster-only assistant needs none of this: the abuse surface is a handful
// of named people. With CHAT_PUBLIC it answers anyone, and the moment that is
// true a token bucket stops being optional.
//
// TWO limits doing TWO jobs, and conflating them is the mistake:
//   the bucket limits ONE CALLER            -> 429, come back later
//   the ceiling limits THE BILL for the day -> 503, the site is done for today
// A bucket alone does not bound the bill. A thousand addresses each politely
// under the limit still spends a thousand times.
const CEILING_TTL = 60 * 60 * 48;
const BUCKET_TTL = 60 * 60 * 2;

const limit = (env, key, fallback) => {
  const n = Number(env[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// ⚠️ A salted hash, never the address itself. The counter needs to tell callers
// apart; it does not need to know who they are, and an IP column is a log of
// who read what.
async function fingerprint(env, request) {
  // ⚠️ `cf-connecting-ip` ONLY. x-forwarded-for was a fallback here, and it is
  // set by the client: anyone rate-limited could rotate the header and get a
  // fresh bucket every request, which is the same as having no per-caller limit
  // at all. Cloudflare always sets cf-connecting-ip on proxied traffic, so the
  // fallback was unreachable in production and purely a way to be wrong later.
  // With no header at all everyone shares one bucket, which fails closed.
  const ip = request.headers.get('cf-connecting-ip') || 'no-address';
  const data = new TextEncoder().encode(`${env.SESSION_SECRET || 'unsalted'}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One statement, so the read and the increment cannot interleave. A
// check-then-write here would let two simultaneous requests both pass a limit
// that only one of them should have.
async function bump(env, bucket, ttlSeconds) {
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO chat_rate (bucket, n, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET n = n + 1 RETURNING n`
  ).bind(bucket, expires).first();
  return Number(row?.n ?? 1);
}

export async function handleChat(request, env, me) {
  // The assistant reads what this person may read, and nothing else (band.js viewEnv).
  env = viewEnv(request, env, me);
  if (!flag(env, 'CHAT_ENABLED')) return json({ error: 'The assistant is switched off for this project.' }, 503);
  // A chat turn spends money and writes a row, so by default it is a write,
  // and writes are roster-only. CHAT_PUBLIC opens it to anyone -- which is
  // exactly why the two limits below exist. (A PRIVATE instance refuses an
  // anonymous caller before this runs, whatever CHAT_PUBLIC says.)
  const open = flag(env, 'CHAT_PUBLIC');
  if (!me.can_write && !open) return json({ error: 'not permitted' }, 403);
  const geminiKey = await secretValue(env, 'GEMINI_API_KEY');
  if (!geminiKey) return json({ error: 'The assistant has no API key configured for this project.' }, 503);

  const stamp = new Date().toISOString();

  // ⚠️ BEFORE the model call, because the model call is the thing that costs
  // money. Checking afterwards would record the limit and pay the bill anyway.
  const ceiling = limit(env, 'CHAT_DAILY_TURN_CEILING', 0);
  if (ceiling > 0 && await bump(env, `site:${stamp.slice(0, 10)}`, CEILING_TTL) > ceiling) {
    console.error(`[chat] daily ceiling of ${ceiling} turns reached`);
    return json({ error: 'The assistant has answered as many questions as it can today. It resets tomorrow.' }, 503);
  }

  // Roster members are exempt from the per-caller bucket and still counted
  // against the ceiling: they are accountable by name, and the ceiling is about
  // the bill rather than about trust.
  if (!me.can_write) {
    const perHour = limit(env, 'CHAT_RATE_PER_IP_HOUR', 0);
    if (perHour > 0) {
      const who = await fingerprint(env, request);
      if (await bump(env, `ip:${who}:${stamp.slice(0, 13)}`, BUCKET_TTL) > perHour) {
        return json({ error: 'That is a lot of questions at once. Try again in a little while.' }, 429, { 'retry-after': '600' });
      }
    }
  }

  const body = await request.json().catch(() => null);
  const message = String(body?.message || '').trim();
  if (!message) return json({ error: 'message required' }, 400);
  // ⚠️ The only write path here that also spends money on somebody else's
  // infrastructure. Same limit as an answer, refused for the same reason.
  //
  // ⚠️ AFTER the counters above, deliberately. A refused turn still costs the
  // caller a token, because otherwise a public visitor could hold their bucket
  // open indefinitely by sending bodies they know will be refused. It costs
  // nothing at the model, which is what the counters are protecting.
  const long = overLimit(message);
  if (long) return json({ error: long }, 400);
  const sessionId = String(body?.session_id || crypto.randomUUID());

  const context = await buildContext(env, request);
  if (!context) return json({ error: 'The project material is not available.' }, 503);

  // Prior turns in this session, so a conversation is a conversation.
  // ⚠️ A public turn is stored under the fixed pseudonym `anon`, NOT under a
  // per-visitor id. The session id already separates one conversation from
  // another, so a stable per-reader identifier would add nothing to the
  // transcript and would quietly turn it into a record of who read what.
  const author = me.can_write ? { sub: me.sub, name: me.name } : { sub: 'anon', name: 'Public' };

  const { results: prior } = await env.DB.prepare(
    'SELECT user_message, assistant_message FROM chat_turns WHERE session_id = ? AND author_sub = ? ORDER BY created_at LIMIT 20'
  ).bind(sessionId, author.sub).all();

  // Gemini calls the assistant turn "model", not "assistant".
  const contents = [];
  for (const t of prior || []) {
    contents.push({ role: 'user', parts: [{ text: t.user_message }] });
    if (t.assistant_message) contents.push({ role: 'model', parts: [{ text: t.assistant_message }] });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const model = String(env.CHAT_MODEL || DEFAULT_MODEL).trim();
  const started = Date.now();
  let answer = null, error = null;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': String(geminiKey).trim(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: `${SYSTEM}\n\n---\n\n${context}` }] },
        contents,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
      }),
    });
    if (!r.ok) {
      error = `${r.status}: ${(await r.text()).slice(0, 300)}`;
    } else {
      const data = await r.json();
      const candidate = (data.candidates || [])[0];
      answer = ((candidate?.content?.parts) || []).map((p) => p.text).filter(Boolean).join('\n').trim();
      // ⚠️ An empty answer with no HTTP error is a real Gemini outcome -- a
      // safety block or a hit token ceiling returns 200 with no text and a
      // finishReason. Storing that as a successful empty answer would make the
      // transcript claim the assistant said nothing when it was stopped.
      if (!answer) {
        // Null, not an empty string: the row must not read as "the assistant
        // replied with nothing", which is a different event from being stopped.
        answer = null;
        error = `empty response, finishReason=${candidate?.finishReason || 'unknown'}`;
      }
    }
  } catch (e) {
    error = e.message;
  }

  // ⚠️ Stored whether it succeeded or not, and with the person on it. GMTools'
  // logger records a session and no user, so its log cannot answer the first
  // question anyone asks of it; and it writes to two best-effort sinks, so a
  // failed turn vanishes with nothing saying so. One store, and a failure is a
  // row that says it failed.
  await env.DB.prepare(
    `INSERT INTO chat_turns (id, session_id, author_sub, author_name, created_at, user_message, assistant_message, model, cited, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), sessionId, author.sub, author.name, new Date().toISOString(),
    message, answer, model,
    JSON.stringify([...new Set((answer || '').match(/\/[a-z0-9-]+\/#[a-z0-9-]+/gi) || [])]),
    error,
  ).run();

  if (error) {
    console.error(`[chat] the model call failed: ${error}`);
    return json({ error: 'The assistant could not answer just now. The question was recorded.', session_id: sessionId }, 502);
  }
  return json({ session_id: sessionId, answer, ms: Date.now() - started });
}

export async function listSessions(env, me) {
  if (!isEditor(me)) return json({ error: 'not permitted' }, 403);
  const { results } = await env.DB.prepare(
    `SELECT session_id, author_name, COUNT(*) AS turns, MIN(created_at) AS started, MAX(created_at) AS last
       FROM chat_turns GROUP BY session_id ORDER BY last DESC LIMIT 100`
  ).all();
  return json({ sessions: results || [] });
}

export async function readSession(env, me, sessionId) {
  if (!isEditor(me)) return json({ error: 'not permitted' }, 403);
  const { results } = await env.DB.prepare(
    'SELECT * FROM chat_turns WHERE session_id = ? ORDER BY created_at'
  ).bind(sessionId).all();
  return json({ turns: results || [] });
}

// ⚠️ A retention period nothing enforces is a lie. This runs on a cron trigger
// and the gate holds it to deleting what it claims and nothing else.
export async function enforceRetention(env) {
  const days = Number(env.CHAT_RETENTION_DAYS || 90);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`[chat] CHAT_RETENTION_DAYS is ${env.CHAT_RETENTION_DAYS}; refusing to run rather than deleting everything`);
    return { deleted: 0, skipped: true };
  }
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const r = await env.DB.prepare('DELETE FROM chat_turns WHERE created_at < ?').bind(cutoff).run();
  const deleted = r?.meta?.changes ?? 0;

  // ⚠️ Spent rate-limit counters go with them, and on the SAME schedule rather
  // than a second one. A counter table nothing sweeps grows one row per address
  // per hour forever, which is a slow leak nobody would think to look for.
  // ⚠️ Not gated on `days`: an expired counter is expired whatever the
  // retention period says, and the refusal above is about not deleting
  // transcripts on a nonsense period.
  const swept = await env.DB.prepare('DELETE FROM chat_rate WHERE expires_at < ?')
    .bind(new Date().toISOString()).run().catch(() => null);
  const expired = swept?.meta?.changes ?? 0;

  console.log(`[chat] retention: deleted ${deleted} turn(s) older than ${days} days, swept ${expired} spent rate counter(s)`);
  return { deleted, cutoff, expired };
}
