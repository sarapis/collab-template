import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAuthorizeHandler, oauthMcpHandler } from '../src/oauth.js';
import { issue } from '../src/session.js';
import { handleMcp } from '../src/mcp.js';
import { CLASSIC } from './classic.js';

// ⚠️ entry.js is not imported here: it pulls in the OAuth provider package,
// which imports `cloudflare:workers` and cannot load in Node. What is testable
// without it is the part that matters — who the front door lets through, whose
// name it acts under, and whether a revoked person stays revoked.

// The roster is a table now, so the stub carries one.
const USERS = [
  { email: 'devin@example.org', name: 'Devin', role: 'contributor', audiences: '["devin"]', disabled_at: null },
  { email: 'olivia@example.org', name: 'Olivia', role: 'contributor', audiences: '["olivia"]', disabled_at: null },
  { email: 'guest@example.org', name: 'Guest', role: 'user', audiences: '["devin"]', disabled_at: null },
];

const site = { fetch: async () => new Response('the site', { status: 200 }) };

function env(extra = {}) {
  const list = extra.users || USERS;
  return {
    // The roster is a table, so even the OAuth stub needs one.
    DB: { prepare: (sql) => ({ bind: (...a) => ({
      run: async () => ({}), all: async () => ({ results: [] }),
      first: async () => (/FROM users WHERE email/.test(sql) ? list.find((u) => u.email === a[0]) || null : null),
    }) }), batch: async () => {} },
    COLLAB_HOST: CLASSIC, AGENT_TOKENS: '{}', SESSION_SECRET: 'test-secret', PUBLIC_READ: 'false',
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({ clientId: 'Claude', scope: ['collab'] }),
      completeAuthorization: async ({ userId, props }) => {
        env.lastAuthorization = { userId, props };
        return { redirectTo: 'https://claude.ai/callback?code=abc' };
      },
    },
    ...extra,
  };
}

const get = (path, cookie) => new Request(`https://x${path}`, cookie ? { headers: { cookie } } : {});

test('anything that is not /authorize goes to the site untouched', async () => {
  const h = makeAuthorizeHandler(site);
  const r = await h.fetch(get('/summary/'), env(), {});
  assert.equal(await r.text(), 'the site');
});

test('an unauthenticated authorize is sent through the sign-in this site already has', async () => {
  // ⚠️ Not a second password prompt. The worker this was extracted from had to
  // ask for one because the box owned identity; here the Worker is the identity
  // authority, so a person types their address in one place only.
  const h = makeAuthorizeHandler(site);
  const r = await h.fetch(get('/authorize?client_id=x&state=y'), env(), {});
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/auth\/login\?next=%2Fauthorize/);
});

test('a signed-in person is shown what the connection can do, and asked', async () => {
  const e = env();
  const cookie = `collab_session=${await issue('devin@example.org', e)}`;
  const r = await makeAuthorizeHandler(site).fetch(get('/authorize?client_id=x', cookie), e, {});
  const html = await r.text();
  assert.match(html, /is asking to connect/);
  assert.match(html, /as <strong>Devin<\/strong>/);
  assert.match(html, /post answers and replies/);
  assert.match(html, /cannot change a document/);
});

test('approving carries only the roster key, never the permissions', async () => {
  // A token that embedded what somebody may do would outlive the decision to
  // take it away. The roster is re-read on every call instead.
  const e = env();
  const cookie = `collab_session=${await issue('devin@example.org', e)}`;
  const req = new Request('https://x/authorize?client_id=x', {
    method: 'POST', headers: { cookie }, body: new URLSearchParams({ approve: 'yes' }),
  });
  const r = await makeAuthorizeHandler(site).fetch(req, e, {});
  assert.equal(r.status, 302);
  assert.equal(env.lastAuthorization.userId, 'devin@example.org');
  assert.deepEqual(env.lastAuthorization.props, { sub: 'devin@example.org' });
  assert.equal('role' in env.lastAuthorization.props, false);
  assert.equal('audiences' in env.lastAuthorization.props, false);
});

test('declining goes nowhere near completeAuthorization', async () => {
  const e = env();
  env.lastAuthorization = null;
  const cookie = `collab_session=${await issue('devin@example.org', e)}`;
  const req = new Request('https://x/authorize?client_id=x', {
    method: 'POST', headers: { cookie }, body: new URLSearchParams({}),
  });
  const r = await makeAuthorizeHandler(site).fetch(req, e, {});
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  assert.equal(env.lastAuthorization, null);
});

test('a connector authorised by somebody since removed stops working', async () => {
  // Removing somebody takes effect on their next call. A token already issued
  // must not survive it — which is why the token carries only the roster key and
  // the roster is re-read every time.
  const after = env({ users: [] });
  const r = await oauthMcpHandler.fetch(
    new Request('https://x/connect', { method: 'POST', body: '{}' }), after, { props: { sub: 'devin@example.org' } });
  assert.equal(r.status, 401);
  assert.match(await r.text(), /no longer authorised/);
});

test('the OAuth door and the bearer door reach the same person', async () => {
  // Two doors that resolved identity differently is how an agent ends up able to
  // do something a person cannot.
  const e = {
    ...env(),
    ASSETS: { fetch: async () => new Response('{"project":{},"docs":[],"questions":[],"audiences":{},"asked_rounds":{}}', { status: 200 }) },
    MCP_HANDLERS: {},
  };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_documents', arguments: {} } });
  const viaOauth = await oauthMcpHandler.fetch(
    new Request('https://x/connect', { method: 'POST', body }), e, { props: { sub: 'devin@example.org' } }).then((r) => r.json());
  const viaBearer = await handleMcp(
    new Request('https://x/mcp', { method: 'POST', body }), e,
    { authenticated: true, can_write: true, sub: 'devin', name: 'Devin', audiences: ['devin'], role: 'contributor' },
    {}).then((r) => r.json());
  assert.deepEqual(viaOauth.result, viaBearer.result);
});

test('a GET to the OAuth MCP route is refused', async () => {
  const r = await oauthMcpHandler.fetch(new Request('https://x/connect'), env(), { props: { sub: 'devin@example.org' } });
  assert.equal(r.status, 405);
});
