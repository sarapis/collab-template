// Managing people.
//
// ⚠️ Every change writes to membership_log, which is append-only and never
// edited. That log is what replaces the pull request: a roster in a database
// with no record of who changed it is how a login list stops being one list and
// becomes a judgement call nobody can reconstruct.

import { listPeople, record, readLog, validRole, ROLES, isRoot } from './people.js';
import { handleSecrets, MANAGEABLE } from './secrets.js';
import { viewEnv } from './band.js';
import { declaredGroups } from './waits.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const clean = (e) => String(e || '').trim().toLowerCase();
const looksLikeEmail = (e) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e);

// The groups a person can belong to: site.config.yml `audiences`, read from the
// live manifest, which is what addresses every question to one of them. On the
// page they are "Groups"; in storage and in the manifest they stay `audiences`.
//
// ⚠️ null means the manifest could not be read, which is NOT the same as a site
// with no groups. It was a free-text field, and a typo (`owners`) was stored
// without complaint and then matched no question, so the person's queue read 0
// and nothing said why. Checking against the list closes that; refusing every
// roster edit because the manifest was briefly unreadable would be worse.
async function configuredGroups(request, env, me) {
  const m = await viewEnv(request, env, me).ASSETS?.fetch(new Request(new URL('/manifest.json', request.url)))
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!m) return null;
  // Audiences and addressees (v1.11.0): a person is put in whatever a question can wait on.
  return declaredGroups(m);
}

const groupList = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : []);

// ⚠️ A group the person ALREADY has passes even if the site no longer defines
// it, so removing one group never fails over another that was renamed away.
function unknownGroups(list, groups, kept = []) {
  if (!groups) return [];
  const ok = new Set([...groups.map((g) => g.id), ...kept]);
  return list.filter((g) => !ok.has(g));
}

const notAGroup = (bad, groups) => json({
  error: `not a group on this site: ${bad.join(', ')}. The groups are ${groups.map((g) => g.id).join(', ') || '(none defined)'}.`,
}, 400);

function refuse(me) {
  if (!me.authenticated) return json({ error: 'not signed in' }, 401);
  if (me.role !== 'admin') return json({ error: 'not permitted' }, 403);
  return null;
}

// Identities in the stores that belong to nobody on the roster.
//
// ⚠️ This exists because it already happened and nothing noticed for two days.
// The roster moved out of site.config.yml, where a person was keyed by a short
// name, into a table where a person is keyed by their email — and the answers
// somebody had already written kept the old key. Everything still WORKED, which
// is what made it invisible: the answers rendered, the names were right, the
// counts were plausible. What broke was every check of the form
// `author_sub === me.sub`, silently and in the safe direction. The author could
// no longer edit their own answers (`mine` was false and PATCH said "not
// yours"), and ten questions they had personally answered went on reporting
// themselves as waiting for them.
//
// No test could have caught it: the code was correct on both sides of the
// migration and the drift was in the data. So the roster's own page says when
// somebody wrote something under a name the roster does not know.
async function orphanIdentities(env, people) {
  const known = new Set((people || []).map((p) => String(p.email || '').toLowerCase()));
  // ⚠️ `anon` is the fixed pseudonym every PUBLIC assistant turn is stored
  // under. It belongs to nobody by design, so without this every public
  // conversation would report itself as a lost identity and the panel would be
  // permanently, uselessly full — which is how a real warning gets ignored.
  known.add('anon');
  const stores = [
    ['answers', 'SELECT author_sub AS who, COUNT(*) AS n FROM answers GROUP BY author_sub'],
    ['comments', 'SELECT author_sub AS who, COUNT(*) AS n FROM comments GROUP BY author_sub'],
    ['conversations', 'SELECT author_sub AS who, COUNT(*) AS n FROM chat_turns GROUP BY author_sub'],
  ];
  const out = [];
  for (const [store, sql] of stores) {
    const { results } = await env.DB.prepare(sql).all().catch(() => ({ results: [] }));
    for (const r of results || []) {
      const who = String(r.who || '');
      if (!who || known.has(who.toLowerCase())) continue;
      out.push({ who, store, count: r.n });
    }
  }
  return out;
}

export async function handleAdmin(request, env, me, url) {
  const no = refuse(me);
  if (no) return no;

  const p = url.pathname;
  const method = request.method.toUpperCase();

  if (p === '/api/admin/people' && method === 'GET') {
    const people = await listPeople(env);
    return json({ people, roles: ROLES, groups: await configuredGroups(request, env, me), you: me.email, orphans: await orphanIdentities(env, people) });
  }

  if (p === '/api/admin/log' && method === 'GET') {
    return json({ entries: await readLog(env) });
  }

  // ⚠️ Every change is written to membership_log — the SAME append-only record
  // as a roster change, because "who gave this site an API key, and when" is
  // the same class of fact as "who was given access". ⚠️ The value is never
  // written to it, and never returned by any route here.
  if (p === '/api/admin/secrets' && method === 'GET') return handleSecrets(request, env, me);
  if (p.startsWith('/api/admin/secrets/')) {
    const name = decodeURIComponent(p.split('/')[4] || '');
    if (!(name in MANAGEABLE)) return json({ error: 'not a manageable setting' }, 400);
    const r = await handleSecrets(request, env, me, name);
    if (r.status < 300) {
      await record(env, me.email, method === 'DELETE' ? 'secret_cleared' : 'secret_set', name, null);
    }
    return r;
  }


  if (p === '/api/admin/people' && method === 'POST') {
    const body = await request.json().catch(() => null);
    const email = clean(body?.email);
    const name = String(body?.name || '').trim();
    const role = String(body?.role || 'user');
    const audiences = groupList(body?.audiences);

    if (!looksLikeEmail(email)) return json({ error: 'that does not look like an email address' }, 400);
    if (!name) return json({ error: 'a name is required — it is what other people see on an answer' }, 400);
    if (!validRole(role)) return json({ error: `role must be one of ${ROLES.join(', ')}` }, 400);
    if (audiences.length) {
      const groups = await configuredGroups(request, env, me);
      const bad = unknownGroups(audiences, groups);
      if (bad.length) return notAGroup(bad, groups);
    }

    const existing = await env.DB.prepare('SELECT email FROM users WHERE email = ?').bind(email).first();
    if (existing) return json({ error: 'that address is already on the roster' }, 409);

    await env.DB.prepare(
      'INSERT INTO users (email, name, role, audiences, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(email, name, role, JSON.stringify(audiences), new Date().toISOString(), me.email).run();
    await record(env, me.email, 'added', email, `as ${role}`);
    return json({ ok: true }, 201);
  }

  const match = p.match(/^\/api\/admin\/people\/(.+)$/);
  if (match) {
    const email = clean(decodeURIComponent(match[1]));
    let row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

    if (method === 'PATCH') {
      const body = await request.json().catch(() => null);
      // ⚠️ The deployed-with account is listed on the page without a row in the
      // table (people.js), so every edit to it used to answer "no such person"
      // and the owner could not be put in a group at all. Give it a row on its
      // first edit; it stays an admin whatever the row says.
      if (!row && isRoot(env, email)) {
        await env.DB.prepare(
          'INSERT INTO users (email, name, role, audiences, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(email, 'Owner', 'admin', '[]', new Date().toISOString(), me.email).run();
        await record(env, me.email, 'added', email, 'the deployed-with account, given a row on its first edit');
        row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      }
      if (!row) return json({ error: 'no such person' }, 404);

      if (body?.role !== undefined) {
        if (!validRole(body.role)) return json({ error: `role must be one of ${ROLES.join(', ')}` }, 400);
        // ⚠️ An admin must not be able to remove the last way back in. The root
        // admin is set at deploy and cannot be demoted from inside the site.
        if (isRoot(env, email) && body.role !== 'admin') {
          return json({ error: 'this is the account the site was deployed with; it cannot be demoted here' }, 400);
        }
        if (body.role !== row.role) {
          // ⚠️ Capture what it was BEFORE the update. Reading it afterwards made
          // the log say "admin → admin" — a record of a change that records
          // neither side of it.
          const was = row.role;
          await env.DB.prepare('UPDATE users SET role = ? WHERE email = ?').bind(body.role, email).run();
          await record(env, me.email, 'role_changed', email, `${was} → ${body.role}`);
        }
      }

      if (body?.audiences !== undefined) {
        const list = groupList(body.audiences);
        const had = (() => { try { return JSON.parse(row.audiences || '[]'); } catch { return []; } })();
        const groups = list.length ? await configuredGroups(request, env, me) : null;
        const bad = unknownGroups(list, groups, had);
        if (bad.length) return notAGroup(bad, groups);
        const next = JSON.stringify(list);
        const wasAudiences = row.audiences;
        if (next !== wasAudiences) {
          await env.DB.prepare('UPDATE users SET audiences = ? WHERE email = ?').bind(next, email).run();
          await record(env, me.email, 'groups_changed', email, `${wasAudiences} → ${next}`);
        }
      }

      if (body?.name) {
        await env.DB.prepare('UPDATE users SET name = ? WHERE email = ?').bind(String(body.name).trim(), email).run();
      }

      if (body?.disabled !== undefined) {
        if (isRoot(env, email) && body.disabled) {
          return json({ error: 'this is the account the site was deployed with; it cannot be disabled here' }, 400);
        }
        const at = body.disabled ? new Date().toISOString() : null;
        await env.DB.prepare('UPDATE users SET disabled_at = ? WHERE email = ?').bind(at, email).run();
        await record(env, me.email, body.disabled ? 'disabled' : 'enabled', email, null);
      }

      return json({ ok: true });
    }

    if (method === 'DELETE') {
      if (!row) return json({ error: 'no such person' }, 404);
      if (isRoot(env, email)) {
        return json({ error: 'this is the account the site was deployed with; it cannot be removed here' }, 400);
      }
      // ⚠️ Removing somebody does not remove what they wrote. Answers and
      // comments are evidence the documents cite, and they keep the name that
      // was on them.
      await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run();
      await record(env, me.email, 'removed', email, `was ${row.role}`);
      return json({ ok: true });
    }
  }

  return json({ error: 'no such route' }, 404);
}
