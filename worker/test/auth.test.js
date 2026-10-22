import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { PROJECT } from '../src/site.generated.js';
import { issue, sign } from '../src/session.js';
import { CLASSIC } from './classic.js';

// The roster is a table now, so the stub carries one.
const USERS = [
  { email: 'devin@example.org', name: 'Devin', role: 'contributor', audiences: '["devin"]', disabled_at: null },
  { email: 'olivia@example.org', name: 'Olivia', role: 'contributor', audiences: '["olivia"]', disabled_at: null },
];
function envFor(list) {
  return {
    DB: { prepare: (sql) => ({ bind: (...a) => ({
      run: async () => ({}), all: async () => ({ results: [] }),
      first: async () => (/FROM users WHERE email/.test(sql) ? list.find((u) => u.email === a[0]) || null : null),
    }) }), batch: async () => {} },
    COLLAB_HOST: CLASSIC, AGENT_TOKENS: '{}', PUBLIC_READ: 'false',
    SESSION_SECRET: 'test-secret-value', MAGIC_LINK_FROM: 'noreply@example.org', MAGIC_LINK_TO_LOG: 'true',
  };
}

const base = () => envFor(USERS);

const get = (path, headers = {}) => new Request(`https://x${path}`, { headers });

test('an unauthenticated page request is sent to sign in, not refused', async () => {
  // A 401 with no way forward is what makes people share passwords.
  const r = await worker.fetch(get('/notifications/'), base());
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/auth\/login\?next=%2Fnotifications%2F$/);
});

test('the sign-in page offers only the providers that are configured', async () => {
  const withEmail = await worker.fetch(get('/auth/login'), base()).then((r) => r.text());
  assert.match(withEmail, /Email me a sign-in link/);
  assert.equal(/Continue with Google/.test(withEmail), false);

  const withGoogle = await worker.fetch(get('/auth/login'), { ...base(), GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }).then((r) => r.text());
  assert.match(withGoogle, /Continue with Google/);
});

test('a signed session identifies the person the roster names', async () => {
  const env = base();
  const token = await issue('devin@example.org', env);
  const me = await worker.fetch(get('/api/me', { cookie: `collab_session=${token}` }), env).then((r) => r.json());
  assert.equal(me.sub, 'devin@example.org');
  assert.equal(me.via, 'session');
  assert.equal(me.can_write, true);
});

test('a session for somebody removed from the roster stops working', async () => {
  // Revocation takes effect on the next request. A session carrying its own
  // permissions would outlive the decision to take them away.
  const env = envFor(USERS);
  const token = await issue('devin@example.org', env);
  const after = envFor(USERS.filter((u) => u.email !== 'devin@example.org'));
  const me = await worker.fetch(get('/api/me', { cookie: `collab_session=${token}` }), after).then((r) => r.json());
  assert.equal(me.authenticated, false);
});

test('a disabled person is refused without being deleted', async () => {
  // ⚠️ Removing somebody must not remove what they wrote: answers and comments
  // are evidence the documents cite. Disabling keeps the row and the name.
  const disabled = USERS.map((u) => (u.email === 'devin@example.org' ? { ...u, disabled_at: '2026-09-18T00:00:00Z' } : u));
  const env = envFor(disabled);
  const token = await issue('devin@example.org', env);
  const me = await worker.fetch(get('/api/me', { cookie: `collab_session=${token}` }), env).then((r) => r.json());
  assert.equal(me.authenticated, false);
});

test('a tampered session is rejected', async () => {
  const env = base();
  const token = await issue('devin@example.org', env);
  const [body] = token.split('.');
  const forged = `${body}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  const me = await worker.fetch(get('/api/me', { cookie: `collab_session=${forged}` }), env).then((r) => r.json());
  assert.equal(me.authenticated, false);
});

test('a session signed with another secret is rejected', async () => {
  const env = base();
  const token = await issue('devin', { ...env, SESSION_SECRET: 'a-different-secret' });
  const me = await worker.fetch(get('/api/me', { cookie: `collab_session=${token}` }), env).then((r) => r.json());
  assert.equal(me.authenticated, false);
});

test('an expired session is rejected', async () => {
  const env = base();
  const expired = await sign({ sub: 'devin@example.org', epoch: '1', exp: Math.floor(Date.now() / 1000) - 60 }, env.SESSION_SECRET);
  const me = await worker.fetch(get('/api/me', { cookie: `collab_session=${expired}` }), env).then((r) => r.json());
  assert.equal(me.authenticated, false);
});

test('bumping SESSION_EPOCH invalidates every session at once', async () => {
  const env = base();
  const token = await issue('devin@example.org', env);
  const me = await worker.fetch(get('/api/me', { cookie: `collab_session=${token}` }), { ...env, SESSION_EPOCH: '2' }).then((r) => r.json());
  assert.equal(me.authenticated, false);
});

test('the dev sign-in-by-name path is refused once a secret is configured', async () => {
  const env = base();
  const me = await worker.fetch(get('/api/me', { cookie: 'collab_session=devin@example.org' }), env).then((r) => r.json());
  assert.equal(me.authenticated, false);
});

test('a deployment with a roster and no secret yet accepts nobody', async () => {
  // The window between `wrangler deploy` and `wrangler secret put` must not be
  // a window in which anyone can name themselves in a cookie.
  const env = { ...base(), SESSION_SECRET: undefined };
  const me = await worker.fetch(get('/api/me', { cookie: 'collab_session=devin@example.org' }), env).then((r) => r.json());
  assert.equal(me.authenticated, false);
});

test('the dev path works only when switched on deliberately', async () => {
  const env = { ...base(), SESSION_SECRET: undefined, DEV_SIGN_IN: 'true' };
  const me = await worker.fetch(get('/api/me', { cookie: 'collab_session=devin@example.org' }), env).then((r) => r.json());
  assert.equal(me.sub, 'devin@example.org');
});

test('a magic link signs in the person it names', async () => {
  const env = base();
  const t = await sign({ sub: 'olivia@example.org', next: '/questions/', exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET);
  const r = await worker.fetch(get(`/auth/email/verify?t=${encodeURIComponent(t)}`), env);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/questions/');
  assert.match(r.headers.get('set-cookie'), /collab_session=.+HttpOnly/);
});

test('a magic link for somebody since removed is refused', async () => {
  const env = envFor(USERS);
  const t = await sign({ sub: 'devin@example.org', next: '/', exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET);
  const after = envFor(USERS.filter((u) => u.email !== 'devin@example.org'));
  const r = await worker.fetch(get(`/auth/email/verify?t=${encodeURIComponent(t)}`), after);
  assert.equal(r.status, 403);
});

test('an expired magic link is refused', async () => {
  const env = base();
  const t = await sign({ sub: 'devin@example.org', next: '/', exp: Math.floor(Date.now() / 1000) - 10 }, env.SESSION_SECRET);
  const r = await worker.fetch(get(`/auth/email/verify?t=${encodeURIComponent(t)}`), env);
  assert.equal(r.status, 400);
});

test('the email form answers identically for a stranger and for a member', async () => {
  // Otherwise the sign-in form is a way to ask who has access.
  const env = base();
  const post = (email) => worker.fetch(new Request('https://x/auth/email/start', {
    method: 'POST', body: new URLSearchParams({ email, next: '/' }),
  }), env).then((r) => r.text());
  assert.equal(await post('devin@example.org'), await post('a-stranger@example.com'));
});

test('an OAuth callback without matching state is refused', async () => {
  const env = { ...base(), GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' };
  const r = await worker.fetch(get('/auth/google/callback?code=x&state=forged|/'), env);
  assert.equal(r.status, 400);
});

test('signing out clears the cookie', async () => {
  const r = await worker.fetch(get('/auth/logout'), base());
  assert.equal(r.status, 302);
  assert.match(r.headers.get('set-cookie'), /collab_session=;.*Max-Age=0/);
});

test('a provider that is not configured cannot be started', async () => {
  const r = await worker.fetch(get('/auth/google/start'), base());
  assert.equal(r.status, 404);
});

test('the email form refuses plainly when no sender is configured', async () => {
  // Independent of who is asking, so it leaks nothing -- and it does not
  // promise an email that cannot be sent.
  const env = { ...base(), MAGIC_LINK_TO_LOG: undefined };
  const r = await worker.fetch(new Request('https://x/auth/email/start', {
    method: 'POST', body: new URLSearchParams({ email: 'devin@example.org', next: '/' }),
  }), env);
  assert.equal(r.status, 503);
});

test('a flag set with a trailing newline still counts as set', async () => {
  // `echo true | wrangler secret put X` stores "true\n". A strict comparison
  // rejects it silently: the switch looks set and the feature stays off.
  const env = { ...base(), MAGIC_LINK_TO_LOG: 'true\n' };
  const r = await worker.fetch(new Request('https://x/auth/email/start', {
    method: 'POST', body: new URLSearchParams({ email: 'devin@example.org', next: '/' }),
  }), env);
  assert.equal(r.status, 200);
});

test('a flag set to something else is not set', async () => {
  const env = { ...base(), MAGIC_LINK_TO_LOG: 'yes please' };
  const r = await worker.fetch(new Request('https://x/auth/email/start', {
    method: 'POST', body: new URLSearchParams({ email: 'devin@example.org', next: '/' }),
  }), env);
  assert.equal(r.status, 503);
});

test('a send Resend refuses is reported in the log and stays neutral to the visitor', async () => {
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"message":"domain is not verified"}', { status: 403 });
  try {
    const env = { ...base(), RESEND_API_KEY: 'k', MAGIC_LINK_TO_LOG: undefined };
    const r = await worker.fetch(new Request('https://x/auth/email/start', {
      method: 'POST', body: new URLSearchParams({ email: 'devin@example.org', next: '/' }),
    }), env);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Check your email/);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Resend refused 403/);
    assert.match(errors[0], /domain is not verified/);
  } finally {
    console.error = realError;
    globalThis.fetch = realFetch;
  }
});

test('a key pasted with a trailing newline still works', async () => {
  // A key copied from a dashboard usually carries one, and `Bearer re_x\n` is
  // an invalid header value -- which reads as a bad key and sends you looking
  // in the wrong place.
  let sent = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_u, init) => { sent = init.headers.authorization; return new Response('{}', { status: 200 }); };
  try {
    const env = { ...base(), RESEND_API_KEY: 're_test_key\n', MAGIC_LINK_TO_LOG: undefined };
    await worker.fetch(new Request('https://x/auth/email/start', {
      method: 'POST', body: new URLSearchParams({ email: 'devin@example.org', next: '/' }),
    }), env);
    assert.equal(sent, 'Bearer re_test_key');
  } finally { globalThis.fetch = realFetch; }
});




test('a link whose signature fails is not reported as expired', async () => {
  // ⚠️ The two must be different answers: a valid-but-unsigned link reported as
  // expired sends you to look at the clock instead of at the link.
  const env = base();
  const good = await sign({ sub: 'devin@example.org', next: '/', exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET);
  // ⚠️ Tamper in the MIDDLE of the signature, never at its end. The last
  // base64 character of a 32-byte signature carries only two significant bits,
  // so several different characters decode to identical bytes -- flipping it
  // left the signature valid some runs and not others, which is a flaky test
  // and worse than no test.
  const [body64, sig] = good.split('.');
  const mid = Math.floor(sig.length / 2);
  const tampered = `${body64}.${sig.slice(0, mid)}${sig[mid] === 'A' ? 'B' : 'A'}${sig.slice(mid + 1)}`;
  const body = await worker.fetch(get(`/auth/email/verify?t=${encodeURIComponent(tampered)}`), env).then((r) => r.text());
  assert.match(body, /not valid/);
  assert.equal(/has expired/.test(body), false);
});

test('a genuinely expired link still says expired', async () => {
  const env = base();
  const old = await sign({ sub: 'devin@example.org', next: '/', exp: Math.floor(Date.now() / 1000) - 10 }, env.SESSION_SECRET);
  const body = await worker.fetch(get(`/auth/email/verify?t=${encodeURIComponent(old)}`), env).then((r) => r.text());
  assert.match(body, /has expired/);
});

test('a link with something appended is reported as invalid, not expired', async () => {
  // The exact shape of a copied-link failure: one stray character on the end.
  const env = base();
  const good = await sign({ sub: 'devin@example.org', next: '/', exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET);
  const body = await worker.fetch(get(`/auth/email/verify?t=${encodeURIComponent(good + '\\\\')}`), env).then((r) => r.text());
  assert.match(body, /not valid/);
});

test('the sign-in email carries a plain-text alternative and the URL in full', async () => {
  // Deliverability, not decoration: a single-link HTML email from a new domain
  // is close to a textbook spam signature.
  let body = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response('{"id":"x"}', { status: 200 }); };
  try {
    await worker.fetch(new Request('https://x/auth/email/start', {
      method: 'POST', body: new URLSearchParams({ email: 'devin@example.org', next: '/' }),
    }), { ...base(), RESEND_API_KEY: 'k', MAGIC_LINK_TO_LOG: undefined });
    assert.ok(body.text && body.text.includes('/auth/email/verify'), 'no plain-text part carrying the link');
    assert.ok(body.html.includes('/auth/email/verify'), 'no link in the html part');
    // The display name comes from site.config.yml through the generated module,
    // not from an env var that was a second place to change the same thing.
    // ⚠️ So DERIVE it here. This line used to hardcode one instance's project
    // name, which meant a fork failed a test about the machinery on its first
    // run for no reason other than being called something else.
    assert.equal(body.from, `${PROJECT.name} <noreply@example.org>`);
  } finally { globalThis.fetch = realFetch; }
});

// --- where you land after signing in ---------------------------------------
//
// ⚠️ `next` is attacker-supplied. /auth/login?next=<anywhere> is rendered into
// the form and signed into the magic-link token, so without this a victim who
// signs in normally is redirected off-site with a session just issued — which
// is the whole phishing setup, wearing this site's sign-in flow as the setup.

const landing = async (next) => {
  const env = base();
  const token = await sign({ sub: 'devin@example.org', next, exp: Math.floor(Date.now() / 1000) + 1800 }, env.SESSION_SECRET);
  const r = await worker.fetch(get(`/auth/email/verify?t=${encodeURIComponent(token)}`), env);
  return r.headers.get('location');
};

test('signing in cannot land you on another origin', async () => {
  assert.equal(await landing('https://evil.example.com/phish'), '/');
  assert.equal(await landing('http://evil.example.com'), '/');
});

test('a protocol-relative next is not a path', async () => {
  // ⚠️ `//evil.com` starts with a slash and is a HOST to a browser. A check
  // that only asked "does it start with /" would pass this straight through.
  assert.equal(await landing('//evil.example.com'), '/');
  assert.equal(await landing('/\\evil.example.com'), '/');
});

test('an ordinary path still works, because that is the point', async () => {
  assert.equal(await landing('/summary/#state'), '/summary/#state');
  assert.equal(await landing('/questions/?open=1'), '/questions/?open=1');
  assert.equal(await landing(undefined), '/');
});

// --- `next` on the sign-in page itself (v1.12.2) ---------------------------
//
// ⚠️ Reflected XSS, live until v1.12.2: the page decoded `next` back into the
// email form's hidden input, so /auth/login?next="><script>… ran script on
// this origin. `next` is now validated ONCE (safeNext) and the page, the
// provider links and the redirect all use that value, escaped for where it
// goes. Every payload below must come back as text, never as markup.

const CMS = { CMS_URL: 'https://cms.example.org', CMS_PASS_SECRET: 'c'.repeat(40) };
const loginWith = async (next) => {
  const r = await worker.fetch(get(`/auth/login?next=${encodeURIComponent(next)}`), { ...base(), ...CMS });
  assert.equal(r.status, 200);
  return r.text();
};
const hiddenNext = (page) => (page.match(/<input type="hidden" name="next" value="([^"]*)">/) || [])[1];
const cmsNext = (page) => (page.match(/href="\/auth\/cms\/start\?next=([^"]*)"/) || [])[1];

const ATTACKS = ['"><script>alert(1)</script>', 'javascript:alert(1)', '//evil.example', '/\\evil.example'];

test('an attack in next renders as nothing: the page falls back to /', async () => {
  for (const next of ATTACKS) {
    const page = await loginWith(next);
    assert.ok(!page.includes('<script>alert(1)'), `script reflected for ${next}`);
    assert.ok(!page.includes('evil.example'), `foreign host reflected for ${next}`);
    assert.ok(!page.includes('javascript:'), `scheme reflected for ${next}`);
    assert.equal(hiddenNext(page), '/', next);
    assert.equal(cmsNext(page), '%2F', next);
  }
});

test('a path that carries markup stays a path, escaped as text', async () => {
  // Starts with one slash, so it is same-origin and kept; the quote and the
  // angle brackets must still never become markup.
  const page = await loginWith('/"><script>alert(1)</script>');
  assert.ok(!page.includes('<script>alert(1)'));
  assert.equal(hiddenNext(page), '/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('a normal next round-trips through the page and the provider links', async () => {
  const page = await loginWith('/docs/x?y=1');
  assert.equal(hiddenNext(page), '/docs/x?y=1');
  assert.equal(decodeURIComponent(cmsNext(page)), '/docs/x?y=1');
});

test('landing refuses a scheme, a backslash anywhere and control characters', async () => {
  assert.equal(await landing('javascript:alert(1)'), '/');
  assert.equal(await landing('/docs\\evil'), '/');
  assert.equal(await landing('/x\r\nset-cookie: a=b'), '/');
  assert.equal(await landing('/x\u0000y'), '/');
  assert.equal(await landing('/docs/x?y=1'), '/docs/x?y=1');
});
