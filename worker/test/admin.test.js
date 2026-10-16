import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// The roster is a table, so these tests are mostly about who is allowed to
// change it and what is written down when they do.

function db(seed = [], stores = {}) {
  // ⚠️ A deep copy. The stub mutates rows in place, so a shallow copy let one
  // test's role change leak into the next and made the suite order-dependent —
  // which is the kind of flake that teaches people to re-run until green.
  const rows = { users: seed.map((u) => ({ ...u })), membership_log: [], app_secrets: new Map() };
  const prepare = (sql) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    let args = [];
    const stmt = {
      bind: (...a) => { args = a; return stmt; },
      run: async () => {
        if (s.startsWith('INSERT INTO users')) rows.users.push({ email: args[0], name: args[1], role: args[2], audiences: args[3], created_at: args[4], created_by: args[5], disabled_at: null });
        else if (s.startsWith('INSERT INTO membership_log')) rows.membership_log.push({ id: args[0], at: args[1], actor: args[2], action: args[3], subject: args[4], detail: args[5] });
        else if (s.startsWith('UPDATE users SET role')) { const u = rows.users.find((x) => x.email === args[1]); if (u) u.role = args[0]; }
        else if (s.startsWith('UPDATE users SET audiences')) { const u = rows.users.find((x) => x.email === args[1]); if (u) u.audiences = args[0]; }
        else if (s.startsWith('UPDATE users SET name')) { const u = rows.users.find((x) => x.email === args[1]); if (u) u.name = args[0]; }
        else if (s.startsWith('UPDATE users SET disabled_at')) { const u = rows.users.find((x) => x.email === args[1]); if (u) u.disabled_at = args[0]; }
        else if (s.startsWith('DELETE FROM users')) rows.users = rows.users.filter((x) => x.email !== args[0]);
        else if (s.startsWith('INSERT INTO app_secrets')) rows.app_secrets.set(args[0], { name: args[0], iv: args[1], value: args[2], set_at: args[3], set_by: args[4] });
        else if (s.startsWith('DELETE FROM app_secrets')) rows.app_secrets.delete(args[0]);
        return { success: true };
      },
      all: async () => {
        if (s.includes('FROM users')) return { results: rows.users };
        if (s.includes('FROM membership_log')) return { results: [...rows.membership_log].reverse() };
        if (s.includes('FROM app_secrets')) return { results: [...rows.app_secrets.values()] };
        // The orphan-identity scan: one row per distinct author key per store.
        const group = (list) => {
          const m = new Map();
          for (const who of list || []) m.set(who, (m.get(who) || 0) + 1);
          return { results: [...m].map(([who, n]) => ({ who, n })) };
        };
        if (s.includes('FROM answers GROUP BY author_sub')) return group(stores.answers);
        if (s.includes('FROM comments GROUP BY author_sub')) return group(stores.comments);
        if (s.includes('FROM chat_turns GROUP BY author_sub')) return group(stores.chat_turns);
        return { results: [] };
      },
      first: async () => {
        // A copy, like D1 returns. Handing back the live object let application
        // code read a value it had just overwritten.
        if (s.startsWith('SELECT * FROM users WHERE email')) {
          const found = rows.users.find((u) => u.email === args[0]);
          return found ? { ...found } : null;
        }
        if (s.startsWith('SELECT email FROM users WHERE email')) return rows.users.find((u) => u.email === args[0]) || null;
        if (s.startsWith('SELECT iv, value FROM app_secrets')) return rows.app_secrets.get(args[0]) || null;
        return null;
      },
    };
    return stmt;
  };
  return { rows, prepare, batch: async (x) => { for (const st of x) await st.run(); } };
}

const PEOPLE = [
  { email: 'devin@example.org', name: 'Devin', role: 'admin', audiences: '["devin"]', disabled_at: null },
  { email: 'olivia@example.org', name: 'Olivia', role: 'contributor', audiences: '["olivia"]', disabled_at: null },
];

const env = (DB, extra = {}) => ({
  DB, COLLAB_HOST: CLASSIC, AGENT_TOKENS: '{}', PUBLIC_READ: 'false', DEV_SIGN_IN: 'true',
  ROOT_ADMIN: 'devin@example.org', ...extra,
});

const as = (who, path, method = 'GET', body) => new Request('https://x' + path, {
  method,
  headers: Object.assign(who ? { cookie: `collab_session=${who}` } : {}, body ? { 'content-type': 'application/json' } : {}),
  body: body ? JSON.stringify(body) : undefined,
});

test('a contributor cannot see the roster', async () => {
  const r = await worker.fetch(as('olivia@example.org', '/api/admin/people'), env(db(PEOPLE)));
  assert.equal(r.status, 403);
});

test('an anonymous caller gets 401, not 403', async () => {
  // Different answers for "we do not know you" and "we know you and no".
  const r = await worker.fetch(as(null, '/api/admin/people'), env(db(PEOPLE)));
  assert.equal(r.status, 401);
});

test('an admin sees everyone', async () => {
  const out = await worker.fetch(as('devin@example.org', '/api/admin/people'), env(db(PEOPLE))).then((r) => r.json());
  assert.equal(out.people.length, 2);
  assert.equal(out.people.find((p) => p.email === 'devin@example.org').root, true);
});

test('the deployed-with account is an admin even when the table says otherwise', async () => {
  // ⚠️ The bootstrap has to survive a mistaken edit, or one wrong click locks
  // everybody out of their own site.
  const demoted = [{ ...PEOPLE[0], role: 'user' }, PEOPLE[1]];
  const me = await worker.fetch(as('devin@example.org', '/api/me'), env(db(demoted))).then((r) => r.json());
  assert.equal(me.role, 'admin');
});

test('the deployed-with account works when the table is empty', async () => {
  const me = await worker.fetch(as('devin@example.org', '/api/me'), env(db([]))).then((r) => r.json());
  assert.equal(me.authenticated, true);
  assert.equal(me.role, 'admin');
});

test('adding somebody records who added them', async () => {
  const DB = db(PEOPLE);
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people', 'POST',
    { name: 'Sam', email: 'Sam@Example.org', role: 'user', audiences: ['sam'] }), env(DB));
  assert.equal(r.status, 201);
  // Addresses are compared lowercased, or the same person is two people.
  assert.equal(DB.rows.users.find((u) => u.email === 'sam@example.org').name, 'Sam');
  const log = DB.rows.membership_log[0];
  assert.equal(log.actor, 'devin@example.org');
  assert.equal(log.action, 'added');
  assert.equal(log.subject, 'sam@example.org');
});

test('a name is required, because it is what other people see', async () => {
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people', 'POST',
    { email: 'nameless@example.org', role: 'user' }), env(db(PEOPLE)));
  assert.equal(r.status, 400);
});

test('an address already on the roster is refused', async () => {
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people', 'POST',
    { name: 'Olivia Again', email: 'olivia@example.org', role: 'user' }), env(db(PEOPLE)));
  assert.equal(r.status, 409);
});

test('an invented role is refused', async () => {
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people', 'POST',
    { name: 'X', email: 'x@example.org', role: 'superuser' }), env(db(PEOPLE)));
  assert.equal(r.status, 400);
});

test('a role change is recorded with what it was before', async () => {
  const DB = db(PEOPLE);
  await worker.fetch(as('devin@example.org', '/api/admin/people/olivia@example.org', 'PATCH', { role: 'admin' }), env(DB));
  assert.equal(DB.rows.users.find((u) => u.email === 'olivia@example.org').role, 'admin');
  assert.match(DB.rows.membership_log[0].detail, /contributor → admin/);
});

test('the deployed-with account cannot be demoted, disabled or removed from inside the site', async () => {
  const DB = db(PEOPLE);
  const e = env(DB);
  for (const [method, body] of [['PATCH', { role: 'user' }], ['PATCH', { disabled: true }], ['DELETE', undefined]]) {
    const r = await worker.fetch(as('devin@example.org', '/api/admin/people/devin@example.org', method, body), e);
    assert.equal(r.status, 400, `${method} should be refused`);
  }
  assert.equal(DB.rows.users.find((u) => u.email === 'devin@example.org').role, 'admin');
});

test('disabling somebody keeps their row and refuses their session', async () => {
  const DB = db(PEOPLE);
  const e = env(DB);
  await worker.fetch(as('devin@example.org', '/api/admin/people/olivia@example.org', 'PATCH', { disabled: true }), e);
  assert.equal(DB.rows.users.length, 2, 'the row must stay — answers cite the name on it');
  const me = await worker.fetch(as('olivia@example.org', '/api/me'), e).then((r) => r.json());
  assert.equal(me.authenticated, false);
});

test('a contributor cannot change anybody', async () => {
  const DB = db(PEOPLE);
  const r = await worker.fetch(as('olivia@example.org', '/api/admin/people/devin@example.org', 'PATCH', { role: 'user' }), env(DB));
  assert.equal(r.status, 403);
  assert.equal(DB.rows.membership_log.length, 0);
});

test('the membership log is only ever appended to', async () => {
  // Nothing in the application updates or deletes a row in it.
  const src = await import('node:fs').then((fs) => fs.readFileSync('worker/src/admin.js', 'utf8'));
  assert.equal(/UPDATE membership_log|DELETE FROM membership_log/.test(src), false);
});

// --- identities that belong to nobody ---------------------------------------
//
// ⚠️ These exist because this already happened. The roster moved from
// site.config.yml, where a person was keyed by a short name, into `users`, where
// a person is keyed by their email — and the answers already written kept the
// old key. Nothing errored. The author simply stopped being able to edit their
// own answers, and ten questions they had answered kept reporting themselves as
// waiting for them. No test could catch it: the code was right on both sides of
// the migration and the drift was in the data, so the roster's own page has to
// say so.

test('an identity no roster person owns is reported', async () => {
  const store = db(PEOPLE, { answers: ['devin', 'devin', 'olivia@example.org'] });
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people'), env(store)).then((x) => x.json());
  assert.deepEqual(r.orphans, [{ who: 'devin', store: 'answers', count: 2 }]);
});

test('a roster email is not an orphan, whatever its case', async () => {
  const store = db(PEOPLE, { answers: ['Devin@Example.org'], comments: ['olivia@example.org'] });
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people'), env(store)).then((x) => x.json());
  assert.deepEqual(r.orphans, []);
});

test('every store is scanned, not just answers', async () => {
  const store = db(PEOPLE, { answers: ['ghost'], comments: ['ghost'], chat_turns: ['ghost'] });
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people'), env(store)).then((x) => x.json());
  assert.deepEqual(r.orphans.map((o) => o.store), ['answers', 'comments', 'conversations']);
});

test('a clean store reports nothing at all', async () => {
  // The section is hidden when this is empty. A warning that is always on the
  // page is furniture, and people stop reading furniture.
  const store = db(PEOPLE, { answers: ['devin@example.org'] });
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people'), env(store)).then((x) => x.json());
  assert.deepEqual(r.orphans, []);
});

// --- settings an admin can set from the site --------------------------------
//
// ⚠️ The alternative implementation — give the Worker a Cloudflare API token so
// it can write real Worker secrets — hands a public endpoint a credential that
// can redeploy the Worker. These tests hold the line that the values live in
// D1, encrypted, and that the screen is write-only.

import { secretValue, listSecrets } from '../src/secrets.js';
import { CLASSIC } from './classic.js';

const KEYED = (DB) => env(DB, { SETTINGS_KEY: 'k'.repeat(48) });
const put = (who, name, value) => as(who, `/api/admin/secrets/${name}`, 'PUT', { value });

test('an admin sets a key and the site then uses it', async () => {
  const store = db(PEOPLE);
  const e = KEYED(store);
  assert.equal((await worker.fetch(put('devin@example.org', 'GEMINI_API_KEY', 'g-live'), e)).status, 200);
  assert.equal(await secretValue(e, 'GEMINI_API_KEY'), 'g-live');
});

test('what is stored is ciphertext, not the key', async () => {
  // ⚠️ D1 also holds answers, comments and the roster, and is read by wrangler
  // and by any export script somebody writes later. A dump must yield nothing.
  const store = db(PEOPLE);
  await worker.fetch(put('devin@example.org', 'RESEND_API_KEY', 're_supersecret'), KEYED(store));
  const row = store.rows.app_secrets.get('RESEND_API_KEY');
  assert.ok(row, 'nothing was stored');
  assert.equal(row.value.includes('re_supersecret'), false, 'the value is in the table in the clear');
});

test('no route hands back a SECRET value', async () => {
  // A screen that can show a key back leaks every key to anyone who reaches it
  // once. Every setting not explicitly marked public is in this class.
  const store = db(PEOPLE);
  const e = KEYED(store);
  await worker.fetch(put('devin@example.org', 'GEMINI_API_KEY', 'g-live'), e);
  const body = await worker.fetch(as('devin@example.org', '/api/admin/secrets'), e).then((r) => r.text());
  assert.equal(body.includes('g-live'), false, 'the listing leaked the value');
  assert.match(body, /"source":"stored"/);
});

test('a setting marked public IS handed back, so the field can be edited', async () => {
  // ⚠️ The distinction is not "sensitive" versus "not". It is whether the value
  // is already visible elsewhere by design: a Google client id appears in every
  // visitor's OAuth redirect, so masking it teaches people that the asterisks
  // mean nothing.
  const store = db(PEOPLE);
  const e = KEYED(store);
  await worker.fetch(put('devin@example.org', 'GOOGLE_CLIENT_ID', 'gid.apps.googleusercontent.com'), e);
  const list = await worker.fetch(as('devin@example.org', '/api/admin/secrets'), e).then((r) => r.json());
  const row = list.secrets.find((x) => x.name === 'GOOGLE_CLIENT_ID');
  assert.equal(row.public, true);
  assert.equal(row.value, 'gid.apps.googleusercontent.com');
});

test('public is opt-in, so a forgotten setting fails closed', async () => {
  // ⚠️ The safety property. Adding a setting and not thinking about it leaves it
  // masked and unreadable — the failure of forgetting is a field more private
  // than it needed to be, never one that shows a key.
  const { MANAGEABLE } = await import('../src/secrets.js');
  const masked = Object.entries(MANAGEABLE).filter(([, m]) => !m.public).map(([n]) => n);
  for (const n of ['GEMINI_API_KEY', 'RESEND_API_KEY', 'AGENT_TOKENS', 'GOOGLE_CLIENT_SECRET']) {
    assert.ok(masked.includes(n), `${n} is not masked`);
  }
  const store = db(PEOPLE);
  const e = KEYED(store);
  for (const n of masked) await worker.fetch(put('devin@example.org', n, `value-of-${n}`), e);
  const body = await worker.fetch(as('devin@example.org', '/api/admin/secrets'), e).then((r) => r.text());
  for (const n of masked) assert.equal(body.includes(`value-of-${n}`), false, `${n} leaked`);
});

test('a stored value wins over the deploy-time one', async () => {
  // Setting something here and having it silently not take effect is worse than
  // not offering the screen at all.
  const store = db(PEOPLE);
  const e = env(store, { SETTINGS_KEY: 'k'.repeat(48), GEMINI_API_KEY: 'from-deploy' });
  assert.equal(await secretValue(e, 'GEMINI_API_KEY'), 'from-deploy');
  await worker.fetch(put('devin@example.org', 'GEMINI_API_KEY', 'from-admin'), e);
  assert.equal(await secretValue(e, 'GEMINI_API_KEY'), 'from-admin');
});

test('clearing falls back to the deploy-time value', async () => {
  const store = db(PEOPLE);
  const e = env(store, { SETTINGS_KEY: 'k'.repeat(48), GEMINI_API_KEY: 'from-deploy' });
  await worker.fetch(put('devin@example.org', 'GEMINI_API_KEY', 'from-admin'), e);
  await worker.fetch(as('devin@example.org', '/api/admin/secrets/GEMINI_API_KEY', 'DELETE'), e);
  assert.equal(await secretValue(e, 'GEMINI_API_KEY'), 'from-deploy');
});

test('without SETTINGS_KEY it refuses rather than storing in the clear', async () => {
  // ⚠️ Fail closed. A feature that quietly downgrades into the thing it exists
  // to avoid is worse than one that does not work.
  const store = db(PEOPLE);
  const r = await worker.fetch(put('devin@example.org', 'GEMINI_API_KEY', 'g-live'), env(store));
  assert.equal(r.status, 400);
  assert.equal(store.rows.app_secrets.size, 0);
  assert.match((await r.json()).error, /SETTINGS_KEY/);
});

test('only the allowlist is settable', async () => {
  // ⚠️ Without this an admin sets ROOT_ADMIN or PUBLIC_READ through a form
  // meant for an API key, and takes the site over or locks its owner out.
  const store = db(PEOPLE);
  for (const name of ['ROOT_ADMIN', 'SESSION_SECRET', 'PUBLIC_READ']) {
    const r = await worker.fetch(put('devin@example.org', name, 'x'), KEYED(store));
    assert.equal(r.status, 400, `${name} was accepted`);
  }
  assert.equal(store.rows.app_secrets.size, 0);
});

test('a contributor cannot set or read settings', async () => {
  const store = db(PEOPLE);
  const e = KEYED(store);
  assert.equal((await worker.fetch(as('olivia@example.org', '/api/admin/secrets'), e)).status, 403);
  assert.equal((await worker.fetch(put('olivia@example.org', 'GEMINI_API_KEY', 'x'), e)).status, 403);
});

test('setting a key is written to the append-only log, without the key', async () => {
  const store = db(PEOPLE);
  await worker.fetch(put('devin@example.org', 'GEMINI_API_KEY', 'g-live'), KEYED(store));
  const entry = store.rows.membership_log.find((x) => x.action === 'secret_set');
  assert.ok(entry, 'nothing was recorded');
  assert.equal(entry.subject, 'GEMINI_API_KEY');
  assert.equal(JSON.stringify(entry).includes('g-live'), false, 'the log captured the value');
});

test('a changed SETTINGS_KEY reports rather than looking unset', async () => {
  // ⚠️ Returning undefined silently would read as "no value configured", and
  // somebody would set it again instead of restoring the key.
  const store = db(PEOPLE);
  await worker.fetch(put('devin@example.org', 'GEMINI_API_KEY', 'g-live'), KEYED(store));
  const rotated = env(store, { SETTINGS_KEY: 'j'.repeat(48) });
  assert.equal(await secretValue(rotated, 'GEMINI_API_KEY'), undefined);
  const listed = await listSecrets(rotated);
  assert.equal(listed.find((x) => x.name === 'GEMINI_API_KEY').source, 'stored');
});

test('an admin can turn on Google sign-in without a terminal', async () => {
  // ⚠️ The point of making these manageable. The FIRST provider still has to
  // come from the deploy — you cannot sign in to configure signing in — but a
  // second one should not need a terminal, and "email is the only way in" is a
  // single point of failure worth being able to fix from the site.
  // ⚠️ Two envs over ONE database, because the dev sign-in the admin calls use
  // only applies when SESSION_SECRET is absent, and /auth/login refuses to
  // render without it. Same store, so this is one instance seen twice.
  const store = db(PEOPLE);
  const admin = KEYED(store);
  const site = env(store, { SETTINGS_KEY: 'k'.repeat(48), SESSION_SECRET: 'test-secret-value', MAGIC_LINK_FROM: 'noreply@example.org' });

  const before = await worker.fetch(new Request('https://x/auth/login'), site).then((r) => r.text());
  assert.equal(/Continue with Google/.test(before), false, 'Google offered with no credentials');

  assert.equal((await worker.fetch(put('devin@example.org', 'GOOGLE_CLIENT_ID', 'gid.apps.googleusercontent.com'), admin)).status, 200);
  assert.equal((await worker.fetch(put('devin@example.org', 'GOOGLE_CLIENT_SECRET', 'gsec'), admin)).status, 200);

  const after = await worker.fetch(new Request('https://x/auth/login'), site).then((r) => r.text());
  assert.match(after, /Continue with Google/, 'the button did not appear after both were set');
});

test('one Google credential is not enough to offer the button', async () => {
  // A half-configured provider offers a button that dead-ends at Google with an
  // invalid_client error, which reads as the site being broken.
  const store = db(PEOPLE);
  const site = env(store, { SETTINGS_KEY: 'k'.repeat(48), SESSION_SECRET: 'test-secret-value', MAGIC_LINK_FROM: 'noreply@example.org' });
  await worker.fetch(put('devin@example.org', 'GOOGLE_CLIENT_ID', 'gid'), KEYED(store));
  const page = await worker.fetch(new Request('https://x/auth/login'), site).then((r) => r.text());
  assert.equal(/Continue with Google/.test(page), false);
});

// --- groups (stored as `audiences`) -----------------------------------------

const withGroups = (DB) => env(DB, {
  ASSETS: { fetch: async () => new Response(JSON.stringify({
    questions: [], audiences: { owner: { name: 'The project owner', describes: 'Scope.' }, developers: { name: 'Developers' } },
  }), { status: 200 }) },
});

test('the roster lists the groups the site defines, for the page to offer as choices', async () => {
  const data = await worker.fetch(as('devin@example.org', '/api/admin/people'), withGroups(db(PEOPLE))).then((r) => r.json());
  assert.deepEqual(data.groups, [
    { id: 'owner', name: 'The project owner', describes: 'Scope.' },
    { id: 'developers', name: 'Developers', describes: '' },
  ]);
});

test('a group the site does not define is refused, and the reason names the real ones', async () => {
  const DB = db(PEOPLE);
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people/olivia@example.org', 'PATCH',
    { audiences: ['owners'] }), withGroups(DB));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /owners.*owner, developers/);
  assert.equal(DB.rows.users.find((u) => u.email === 'olivia@example.org').audiences, '["olivia"]');

  const add = await worker.fetch(as('devin@example.org', '/api/admin/people', 'POST',
    { name: 'Sam', email: 'sam@example.org', role: 'user', audiences: ['typo'] }), withGroups(DB));
  assert.equal(add.status, 400);
  assert.equal(DB.rows.users.some((u) => u.email === 'sam@example.org'), false);
});

test('a group the person already has passes even after the site stopped defining it', async () => {
  // Olivia is in `olivia`, which withGroups does not define. Adding a real group
  // must not fail over the old one; dropping it must work too.
  const DB = db(PEOPLE);
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people/olivia@example.org', 'PATCH',
    { audiences: ['olivia', 'developers'] }), withGroups(DB));
  assert.equal(r.status, 200);
  assert.equal(DB.rows.users.find((u) => u.email === 'olivia@example.org').audiences, '["olivia","developers"]');
  const log = DB.rows.membership_log.at(-1);
  assert.equal(log.action, 'groups_changed');
});

test('the deployed-with account can be put in a group although it has no row', async () => {
  // It is listed (people.js) without being in the table, and every PATCH to it
  // used to answer 404 "no such person".
  const DB = db([]);
  const r = await worker.fetch(as('devin@example.org', '/api/admin/people/devin@example.org', 'PATCH',
    { audiences: ['owner'] }), withGroups(DB));
  assert.equal(r.status, 200);
  const me = await worker.fetch(as('devin@example.org', '/api/me'), withGroups(DB)).then((x) => x.json());
  assert.deepEqual(me.audiences, ['owner']);
  assert.equal(me.role, 'admin');
  assert.deepEqual(DB.rows.membership_log.map((e) => e.action), ['added', 'groups_changed']);
});
