// "Sign in with the CMS" (worker/src/cms.js, auth.js): a ticket from another
// domain proves an email; the roster decides.
//
// ⚠️ Almost every test here is a refusal. A sign-in that works is noticed the
// first time anyone uses it; one that also accepts a replayed, re-targeted or
// expired ticket looks exactly the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { verifyTicket, signTicket, TICKET_KIND } from '../src/cms.js';
import { d1 } from './d1.js';
import { CLASSIC } from './classic.js';

const S = 'c'.repeat(40);
const HOST = 'collab.example.org';

// ⚠️ THE SHARED VECTOR. Minted by Node's own crypto exactly as Payload mints
// (Buffer base64url, HMAC-SHA256 over "v1.<body>"). The same string is asserted
// in Civic-Tech-Field-Guide/ctfg-website payload/test-collab-pass.ts, so the
// minting half and this verifying half cannot drift apart silently.
const VECTOR = 'v1.eyJrIjoiY29sbGFiLWlkZW50aXR5IiwibSI6IlBlcnNvbkBFeGFtcGxlLm9yZyIsImgiOiJjb2xsYWIuZXhhbXBsZS5vcmciLCJzIjoic3RhdGUtMTIzIiwiZSI6MjAwMDAwMDAwMH0.8loC7HOh6eCnD_J2jBOoHsfc0pyTAvUtzQ_3qCt-pMo';

test('the shared vector verifies, and the email comes back lowercased', async () => {
  const c = await verifyTicket(VECTOR, S, { host: HOST, state: 'state-123', now: 2000000000 - 60 });
  assert.equal(c?.email, 'person@example.org');
});

test('this side mints the same bytes the CMS does', async () => {
  const t = await signTicket({ k: TICKET_KIND, m: 'Person@Example.org', h: HOST, s: 'state-123', e: 2000000000 }, S);
  assert.equal(t, VECTOR);
});

test('the ticket is refused for every reason it should be', async () => {
  const at = 2000000000 - 60;
  const ok = { host: HOST, state: 'state-123', now: at };
  const v = (t, o = {}) => verifyTicket(t, S, { ...ok, ...o });
  assert.equal(await v(VECTOR, { host: 'other.example.org' }), null, 'another host');
  assert.equal(await v(VECTOR, { state: 'state-999' }), null, 'another sign-in attempt');
  assert.equal(await v(VECTOR, { state: '' }), null, 'no state cookie');
  assert.equal(await v(VECTOR, { now: 2000000000 }), null, 'expired');
  assert.equal(await verifyTicket(VECTOR, 'd'.repeat(40), ok), null, 'another secret');
  assert.equal(await v(VECTOR.slice(0, -2) + 'AA'), null, 'tampered');
  assert.equal(await v(await signTicket({ k: 'ticket', m: 'p@example.org', h: HOST, s: 'state-123', e: at + 60 }, S)), null, 'a tenant ticket is not an identity');
  assert.equal(await v(await signTicket({ k: TICKET_KIND, m: 'p@example.org', h: HOST, s: 'state-123', e: at + 3600 }, S)), null, 'a ticket claiming an hour');
  assert.equal(await v(await signTicket({ k: TICKET_KIND, m: 'nobody', h: HOST, s: 'state-123', e: at + 60 }, S)), null, 'not an email');
  for (const junk of [null, '', 'v1..', 'v2.a.b', 'v1.!!!.???', 'x'.repeat(3000)]) assert.equal(await v(junk), null);
});

// --- through the Worker -------------------------------------------------------

async function site(extra = {}) {
  const DB = d1();
  await DB.prepare("INSERT INTO users (email, name, role, audiences, created_at) VALUES ('person@example.org', 'Person', 'user', '[]', '2026-01-01')").run();
  return { DB, COLLAB_HOST: CLASSIC, SESSION_SECRET: 'session-secret-for-tests', AGENT_TOKENS: '{}', PUBLIC_READ: 'false',
    CMS_PASS_SECRET: S, CMS_URL: 'https://cms.example.org', CMS_LABEL: 'the Field Guide CMS', ...extra };
}
const go = (env, path, cookie) => worker.fetch(new Request(`https://${HOST}${path}`, { headers: cookie ? { cookie } : {} }), env);

async function begin(env, next = '/plan/') {
  const r = await go(env, `/auth/cms/start?next=${encodeURIComponent(next)}`);
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('location'));
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { to, cookie, state: to.searchParams.get('state') };
}
const ticket = (state, over = {}) => signTicket({ k: TICKET_KIND, m: 'person@example.org', h: HOST, s: state, e: Math.floor(Date.now() / 1000) + 120, ...over }, S);

test('the button is there only when the secret and the CMS address are set', async () => {
  assert.match(await (await go(await site(), '/auth/login')).text(), /Sign in with the Field Guide CMS/);
  for (const off of [{ CMS_PASS_SECRET: 'short' }, { CMS_URL: '' }, { CMS_URL: 'http://cms.example.org' }]) {
    const env = await site(off);
    assert.doesNotMatch(await (await go(env, '/auth/login')).text(), /Sign in with/);
    assert.equal((await go(env, '/auth/cms/start')).status, 404);
  }
});

test('start sends the browser to the CMS with this host and a state, and keeps `next` here', async () => {
  const { to, state } = await begin(await site());
  assert.equal(to.origin + to.pathname, 'https://cms.example.org/api/collab-pass/start');
  assert.equal(to.searchParams.get('host'), HOST);
  assert.ok(state.length >= 32);
  assert.equal(to.searchParams.get('next'), null, 'the CMS is never told where the person was going');
});

test('a good ticket signs a roster member in and lands them where they were going', async () => {
  const env = await site();
  const { cookie, state } = await begin(env);
  const r = await go(env, `/auth/cms/callback?ticket=${encodeURIComponent(await ticket(state))}`, cookie);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/plan/');
  assert.match(r.headers.get('set-cookie'), /^collab_session=/);
});

test('a ticket is good once', async () => {
  const env = await site();
  const { cookie, state } = await begin(env);
  const t = encodeURIComponent(await ticket(state));
  assert.equal((await go(env, `/auth/cms/callback?ticket=${t}`, cookie)).status, 302);
  const again = await go(env, `/auth/cms/callback?ticket=${t}`, cookie);
  assert.equal(again.status, 400);
  assert.equal(again.headers.get('set-cookie'), null);
});

test('a ticket from somebody else’s sign-in is refused (login CSRF)', async () => {
  const env = await site();
  const attacker = await begin(env);
  const victim = await begin(env);
  const r = await go(env, `/auth/cms/callback?ticket=${encodeURIComponent(await ticket(attacker.state))}`, victim.cookie);
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('set-cookie'), null);
});

test('the CMS proves an email; the roster decides', async () => {
  const env = await site();
  const { cookie, state } = await begin(env);
  const r = await go(env, `/auth/cms/callback?ticket=${encodeURIComponent(await ticket(state, { m: 'stranger@example.org' }))}`, cookie);
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('set-cookie'), null);
});

test('`next` is still only ever a path on this site', async () => {
  const env = await site();
  const { cookie, state } = await begin(env, 'https://evil.example/');
  const r = await go(env, `/auth/cms/callback?ticket=${encodeURIComponent(await ticket(state))}`, cookie);
  assert.equal(r.headers.get('location'), '/');
});
