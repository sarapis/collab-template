import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { ROUTES } from '../src/routes.js';
import { CLASSIC } from './classic.js';

// Whether a caller may READ, checked at the HTTP door, for every GET route the
// table declares.
//
// ⚠️ THIS FILE EXISTS BECAUSE A PRIVATE INSTANCE SERVED EVERY STORED ANSWER TO
// ANYBODY WHO ASKED. The page branch refused an anonymous reader and the MCP
// door refused one; the /api/ branch called identify() and then dispatched
// without ever consulting the result. `GET /api/answers?q=<project>:<slug>`
// returned people's words, and question ids are guessable by construction.
//
// It survived a green suite because every test here asserted what a caller CAN
// do. Nothing asserted what an anonymous one CANNOT — and the same dispatch
// block runs a sibling instance where open reads are correct, which made
// "reads are open" feel like the default rather than the exception.
//
// ⚠️ DRIVEN FROM `ROUTES`, not from a list written out here. A route added
// later is covered before anybody writes a test for it, which is the only
// version of this check that keeps working after today.

// The gate runs before any handler, so nothing below needs a real database.
const db = () => ({
  prepare: () => ({
    bind() { return this; },
    async run() { return { success: true }; },
    async all() { return { results: [] }; },
    async first() { return null; },
  }),
  batch: async () => {},
});

const USERS = [{ email: 'devin@example.org', name: 'Devin', role: 'admin', audiences: '["devin"]', disabled_at: null }];
const withUsers = () => ({
  prepare: (sql) => ({
    args: [],
    bind(...a) { this.args = a; return this; },
    async run() { return { success: true }; },
    async all() { return { results: [] }; },
    async first() {
      return /FROM users WHERE email/.test(sql) ? USERS.find((u) => u.email === this.args[0]) || null : null;
    },
  }),
  batch: async () => {},
});

const env = (DB, publicRead) => ({
  DB, ASSETS: { fetch: async () => new Response('{}', { status: 200 }) },
  COLLAB_HOST: CLASSIC, AGENT_TOKENS: '{}', PUBLIC_READ: publicRead ? 'true' : 'false', DEV_SIGN_IN: 'true',
});

const get = (path, who) => new Request('https://x' + path, {
  headers: who ? { cookie: `collab_session=${who}` } : {},
});

// Every GET the route table declares under /api/, with parameters filled in.
const READ_ROUTES = ROUTES
  .filter((r) => r.method === 'GET' && r.path.startsWith('/api/'))
  .map((r) => r.path.replace(/:[a-z]+/gi, 'x'));

// ⚠️ `/api/me` is the ONE exemption, because it IS the anonymous shape: it
// answers "who am I" with authenticated:false, which the widget needs before it
// knows whether to offer a sign-in link. Named here so the exemption is a
// decision somebody made rather than a gap.
const OPEN = new Set(['/api/me']);

test('the route table actually yielded routes to check', () => {
  // A check that silently iterates an empty list passes forever.
  assert.ok(READ_ROUTES.length >= 5, `only ${READ_ROUTES.length} GET routes found; the table or the filter has moved`);
  assert.ok(READ_ROUTES.includes('/api/answers'), 'the route this check exists for is not in the list');
});

for (const path of READ_ROUTES) {
  if (OPEN.has(path)) continue;

  test(`private instance: anonymous GET ${path} is refused`, async () => {
    const r = await worker.fetch(get(path, null), env(db(), false));
    assert.equal(r.status, 401, `${path} answered an anonymous caller on a private instance`);
  });

  test(`private instance: anonymous GET ${path} returns no content`, async () => {
    // ⚠️ The status is not the point — the words are. A 401 carrying a body is
    // the same leak with a different number on it.
    const body = await worker.fetch(get(path, null), env(db(), false)).then((x) => x.text());
    for (const key of ['answers', 'comments', 'sessions', 'entries', 'people', 'secrets', 'turns']) {
      assert.equal(body.includes(`"${key}"`), false, `${path} leaked a "${key}" payload while refusing`);
    }
  });

  // ⚠️ Admin routes are excluded from THIS assertion only, and deliberately:
  // they answer 401 to an anonymous caller whatever PUBLIC_READ says, which is
  // correct and indistinguishable from the read gate firing. Excluding them
  // here costs nothing — the three assertions above still cover them, and the
  // private-instance ones are the reason this file exists.
  // The content editor's routes (content.source: rows) are editors-only for the
  // same reason, and covered as such in rows.test.js.
  const EDITORS_ONLY = path.startsWith('/api/admin/') || path.startsWith('/api/content') || path.startsWith('/api/versions');
  if (!EDITORS_ONLY) {
    test(`public instance: anonymous GET ${path} is not refused by the read gate`, async () => {
      // The sibling instance is public on purpose. This gate must not break it;
      // a route may still refuse for its OWN reason (contributor-only), so the
      // assertion is narrow.
      const r = await worker.fetch(get(path, null), env(db(), true));
      assert.notEqual(r.status, 401, `${path} refused a reader on a PUBLIC instance`);
    });
  }

  if (path.startsWith('/api/admin/')) {
    test(`public instance: anonymous GET ${path} is STILL refused`, async () => {
      // Opening reads must never open administration.
      const r = await worker.fetch(get(path, null), env(db(), true));
      assert.equal(r.status, 401, `${path} let an anonymous caller in on a public instance`);
    });
  }

  test(`private instance: a signed-in reader gets past the gate on ${path}`, async () => {
    const r = await worker.fetch(get(path, 'devin@example.org'), env(withUsers(), false));
    assert.notEqual(r.status, 401, `${path} refused a signed-in person`);
  });
}

test('/api/me answers an anonymous caller, and says only that', async () => {
  const r = await worker.fetch(get('/api/me', null), env(db(), false));
  assert.equal(r.status, 200);
  const me = await r.json();
  assert.equal(me.authenticated, false);
  assert.equal(me.can_write, false);
  assert.equal(me.sub, null);
});

test('an anonymous GET /api/answers on a private instance returns no words', async () => {
  // Named after the incident. `q` is a real question id shape; the id scheme is
  // `<project>:<slug>`, so an attacker needs no inside knowledge to guess one.
  const r = await worker.fetch(get('/api/answers?q=sarapis-comms:board-activity', null), env(db(), false));
  assert.equal(r.status, 401);
  assert.equal((await r.text()).includes('answers'), false);
});
