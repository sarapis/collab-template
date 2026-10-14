// The roster, in the database.
//
// ⚠️ It used to live in site.config.yml. That made access reviewable in a diff,
// and it also put every address in the repository — and, once committed, in its
// history permanently, carried by any clone, fork or extracted template even
// after somebody was removed. Nothing about a person is in git now.
//
// What replaces the diff is `membership_log`: append-only, never updated, shown
// on the admin page. A record after the fact rather than review before it, which
// is the honest trade.

const ROLES = ['admin', 'contributor', 'user'];

const shape = (row) => ({
  authenticated: true,
  can_write: !row.disabled_at,
  sub: row.email,
  email: row.email,
  name: row.name || row.email,
  role: row.role,
  audiences: JSON.parse(row.audiences || '[]'),
  disabled: !!row.disabled_at,
});

// ⚠️ The root admin is set at deploy and is NOT in the table. It is the
// bootstrap: an empty or lost database must not lock the owner out of their own
// site, and somebody has to be able to add the first person. It is a secret, so
// not even this one address is in the repository.
function rootAdmin(env) {
  const email = String(env.ROOT_ADMIN || '').trim().toLowerCase();
  return email || null;
}

export function isRoot(env, email) {
  const root = rootAdmin(env);
  return !!root && String(email || '').trim().toLowerCase() === root;
}

export async function findByEmail(env, email) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return null;

  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(want).first();
  if (row) {
    const person = shape(row);
    // The root admin is an admin whatever the row says, so a mistaken edit
    // cannot demote the only account guaranteed to work.
    return isRoot(env, want) ? { ...person, role: 'admin', can_write: true, disabled: false } : person;
  }

  if (isRoot(env, want)) {
    return {
      authenticated: true, can_write: true, sub: want, email: want,
      name: 'Owner', role: 'admin', audiences: [], disabled: false, root: true,
    };
  }
  return null;
}

export async function listPeople(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM users ORDER BY (role = \'admin\') DESC, name').all();
  const people = (results || []).map(shape).map((p) => (isRoot(env, p.email) ? { ...p, root: true } : p));
  const root = rootAdmin(env);
  if (root && !people.some((p) => p.email === root)) {
    people.unshift({ email: root, name: 'Owner', role: 'admin', audiences: [], disabled: false, root: true, implicit: true });
  }
  return people;
}

export async function record(env, actor, action, subject, detail) {
  await env.DB.prepare(
    'INSERT INTO membership_log (id, at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), new Date().toISOString(), actor, action, subject, detail || null).run();
}

export async function readLog(env, limit = 200) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM membership_log ORDER BY at DESC LIMIT ?').bind(limit).all();
  return results || [];
}

export function validRole(role) { return ROLES.includes(role); }
export { ROLES };
