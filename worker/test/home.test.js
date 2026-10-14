import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// `/` is a router, not a page.
//
// ⚠️ The orientation page earns somebody's attention exactly once. After that it
// is in the way of the thing they came for, and every page's brand link points
// here — so getting this wrong sends a returning reader to an explanation of a
// site they already know, every single visit.
//
// Deliberately server-side: the redirect resolves before anything renders, and
// it works with JavaScript off. The widget is additive and must never be what
// decides where somebody lands.

function db() {
  const start_seen = [];
  const USERS = [{ email: 'devin@example.org', name: 'Devin', role: 'contributor', audiences: '["devin"]', disabled_at: null }];
  const prepare = (sql) => {
    let args = [];
    const s = sql.replace(/\s+/g, ' ').trim();
    const stmt = {
      bind: (...a) => { args = a; return stmt; },
      run: async () => {
        if (s.startsWith('INSERT INTO start_seen') && !start_seen.some((r) => r.sub === args[0])) {
          start_seen.push({ sub: args[0], at: args[1] });
        }
        return { success: true };
      },
      all: async () => ({ results: [] }),
      first: async () => {
        if (/FROM users WHERE email/.test(s)) return USERS.find((u) => u.email === args[0]) || null;
        if (s.startsWith('SELECT at FROM start_seen')) return start_seen.find((r) => r.sub === args[0]) || null;
        return null;
      },
    };
    return stmt;
  };
  return { prepare, batch: async () => {}, start_seen };
}

const env = (DB) => ({
  DB, AGENT_TOKENS: '{}', PUBLIC_READ: 'false', DEV_SIGN_IN: 'true',
  ASSETS: { fetch: async (req) => new Response('page: ' + new URL(req.url).pathname, { status: 200 }) },
});

const as = (who, path) => new Request('https://x' + path, { headers: who ? { cookie: `collab_session=${who}` } : {} });

test('a first-time reader is sent to the orientation page', async () => {
  const e = env(db());
  const r = await worker.fetch(as('devin@example.org', '/'), e);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/start/');
});

test('once the orientation page has been served, / goes to the summary', async () => {
  const e = env(db());
  await worker.fetch(as('devin@example.org', '/start/'), e);
  const r = await worker.fetch(as('devin@example.org', '/'), e);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/summary/');
});

test('the orientation page itself stays reachable forever', async () => {
  // It moved to the bottom of the menu; it did not go away. Somebody who wants
  // to reread it must not be redirected out of it.
  const e = env(db());
  await worker.fetch(as('devin@example.org', '/start/'), e);
  const again = await worker.fetch(as('devin@example.org', '/start/'), e);
  assert.equal(again.status, 200);
  assert.match(await again.text(), /page: \/start\//);
});

test('being oriented is recorded once, not on every visit', async () => {
  // ⚠️ First write wins, so the record says when somebody was first oriented
  // rather than when they last wandered back through the page.
  const store = db();
  const e = env(store);
  await worker.fetch(as('devin@example.org', '/start/'), e);
  const first = store.start_seen[0].at;
  await worker.fetch(as('devin@example.org', '/start/'), e);
  assert.equal(store.start_seen.length, 1);
  assert.equal(store.start_seen[0].at, first);
});

test('the router never answers an unauthenticated request with a destination', async () => {
  // Sign-in first: otherwise / leaks whether this person has been here before.
  const r = await worker.fetch(new Request('https://x/'), env(db()));
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/auth\/login\?next=%2F$/);
});

test('the redirect is not cacheable', async () => {
  // ⚠️ A cached 302 at / would pin one person's answer in front of everybody
  // else, and pin it past the moment it stopped being true.
  const r = await worker.fetch(as('devin@example.org', '/'), env(db()));
  assert.match(r.headers.get('cache-control') || '', /no-store/);
});
