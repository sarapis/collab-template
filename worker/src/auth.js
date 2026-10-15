// The providers. Each one has exactly one job: prove an email address.
// Authorisation is the roster, in the repo, reviewable in a diff.
//
// ⚠️ A provider must never be allowed to authorise. Google's hosted-domain hint
// and a GitHub org membership are both claims about an account, not decisions
// about this project -- treating either as permission is how a login list stops
// being one list and becomes two that drift.

import { issue, cookie, readCookie, sign, verify, inspect } from './session.js';
import { findByEmail } from './identity.js';
import { flag } from './flag.js';
import { PROJECT } from './site.generated.js';
import { secretValue } from './secrets.js';
import { cmsEnabled, cmsSecret, verifyTicket, burnTicket } from './cms.js';

// The sign-in page is served by the Worker, not built by Eleventy, so it cannot
// use the site's stylesheet for layout -- there is no sidebar or rail here. It
// does use the SAME design system: it links tokens.css and takes every colour,
// radius and typeface from it. ⚠️ Never hard-code a colour in this file. It is
// the one page a person sees before anything else, and a sign-in screen that
// does not look like the site it guards reads as a phishing page.
const html = (body, status = 200) =>
  new Response(`<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<link rel="stylesheet" href="/tokens.css">
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;
    background:var(--background);color:var(--foreground);
    font-family:var(--font-sans);line-height:1.6}
  .box{width:100%;max-width:27rem;padding:2.5rem 2.4rem;border:1px solid var(--border);
    border-radius:calc(var(--radius) * 1.6);background:var(--card);
    box-shadow:var(--shadow-card)}
  h1{font-family:var(--font-serif);font-weight:600;font-size:1.6rem;
    letter-spacing:-.015em;margin:0 0 .3rem;line-height:1.15}
  .tagline{color:var(--foreground);font-size:.95rem;margin:.1rem 0 .9rem}
  .lede{color:var(--muted-foreground);font-size:.88rem;margin:0 0 1.7rem;
    padding-top:.9rem;border-top:1px solid var(--border)}
  p{font-size:.92rem}
  a{color:var(--primary)}

  .btn{display:flex;align-items:center;justify-content:center;gap:.5rem;
    width:100%;text-decoration:none;font:inherit;font-size:.94rem;font-weight:500;
    cursor:pointer;padding:.7rem 1rem;margin:.55rem 0;border-radius:var(--radius);
    border:1px solid var(--border);background:var(--card);color:var(--foreground);
    transition:background .12s ease, border-color .12s ease, transform .06s ease}
  .btn:hover{background:var(--accent);border-color:var(--ring)}
  .btn:active{transform:translateY(1px)}
  .btn.primary{background:var(--primary);color:var(--primary-foreground);
    border-color:var(--primary);margin-top:.9rem}
  /* A hover that only darkens is invisible on a mid-tone. Lifting the border
     and easing the fill reads on both the light and the dark palette. */
  .btn.primary:hover{background:var(--primary);border-color:var(--ring);opacity:.92}
  .btn:focus-visible,input:focus-visible{outline:2px solid var(--ring);outline-offset:2px}

  form{margin:0}
  label{display:block;font-size:.8rem;font-weight:600;letter-spacing:.01em;
    margin:0 0 .4rem;color:var(--foreground)}
  input{width:100%;font:inherit;font-size:.95rem;padding:.7rem .8rem;
    border:1px solid var(--input);border-radius:var(--radius);
    background:var(--background);color:var(--foreground);
    transition:border-color .12s ease, box-shadow .12s ease}
  input::placeholder{color:var(--muted-foreground);opacity:.7}
  input:hover{border-color:var(--ring)}
  /* The focus ring is the one piece of feedback a keyboard user gets, so it is
     a ring and not just a colour change. */
  input:focus{outline:none;border-color:var(--ring);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 22%, transparent)}

  .rule{border:0;border-top:1px solid var(--border);margin:1.6rem 0 1.3rem;
    position:relative}
  .rule::after{content:"or";position:absolute;top:-.72rem;left:50%;
    transform:translateX(-50%);background:var(--card);padding:0 .6rem;
    color:var(--muted-foreground);font-size:.76rem}
  .note{background:var(--warning);border-left:3px solid var(--warning-line);
    padding:.6rem .8rem;border-radius:var(--radius);font-size:.88rem}
  .foot{color:var(--muted-foreground);font-size:.8rem;margin:1.6rem 0 0;
    padding-top:1rem;border-top:1px solid var(--border)}
</style></head><body><main class="box">${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

// The tagline comes from committed config, but escaping it costs nothing and
// means a future config value with an apostrophe or an ampersand cannot break
// the page.
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const redirect = (to, headers = {}) => new Response(null, { status: 302, headers: { location: to, ...headers } });

// ⚠️ A provider is on when its CREDENTIALS exist — there is no list anywhere
// saying which are enabled, deliberately. Two places to say the same thing is
// how a site ends up offering a button that cannot work, or hiding one that
// could. site.config.yml used to carry an `auth.providers` list that nothing
// read; it was removed rather than wired up, because this is the better half.
//
// ⚠️ ASYNC, because Google's credentials can now be set from /admin/settings as
// well as at deploy. A second provider should not need a terminal.
async function enabled(env) {
  const [gid, gsecret] = await Promise.all([
    secretValue(env, 'GOOGLE_CLIENT_ID'),
    secretValue(env, 'GOOGLE_CLIENT_SECRET'),
  ]);
  return {
    google: !!(gid && gsecret),
    github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    email: !!env.MAGIC_LINK_FROM,
    // On when its secret (32+ characters) and the CMS's address are set.
    cms: cmsEnabled(env),
  };
}

async function loginPage(env, url, note = '') {
  const on = await enabled(env);
  const name = PROJECT.name;
  const next = encodeURIComponent(url.searchParams.get('next') || '/');
  const parts = [
    `<h1>${name}</h1>`,
    PROJECT.tagline ? `<p class="tagline">${esc(PROJECT.tagline)}</p>` : '',
    `<p class="lede">Sign in to read the documents and answer the open questions.</p>`,
  ].filter(Boolean);
  if (note) parts.push(`<p class="note">${note}</p>`);
  if (on.google) parts.push(`<a class="btn" href="/auth/google/start?next=${next}">Continue with Google</a>`);
  if (on.github) parts.push(`<a class="btn" href="/auth/github/start?next=${next}">Continue with GitHub</a>`);
  if (on.cms) parts.push(`<a class="btn" href="/auth/cms/start?next=${next}">Sign in with ${esc(env.CMS_LABEL || 'the CMS')}</a>`);
  if ((on.google || on.github || on.cms) && on.email) parts.push('<hr class="rule">');
  if (on.email) {
    parts.push(`<form method="post" action="/auth/email/start">
      <input type="hidden" name="next" value="${decodeURIComponent(next)}">
      <label for="e">Email me a sign-in link</label>
      <input id="e" name="email" type="email" required autocomplete="email" placeholder="you@example.org">
      <button class="btn primary" type="submit">Send the link</button></form>`);
  }
  if (!on.google && !on.github && !on.email && !on.cms) {
    parts.push('<p>No sign-in method is configured for this instance yet.</p>');
  }
  // Access is a committed list, so being turned away is not a mistake to
  // retry -- say who to ask instead of leaving somebody guessing.
  parts.push(`<p class="foot">Access is by invitation. If your address is not on the
    list, ask whoever runs this project to add it.</p>`);
  return html(parts.join('\n'));
}

// CSRF state, carried in a short-lived signed cookie rather than in memory.
async function setState(env, value) {
  const token = await sign({ v: value, exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET);
  return cookie('collab_state', token, { maxAge: 600 });
}

async function checkState(request, env, presented) {
  const raw = readCookie(request, 'collab_state');
  const payload = raw ? await verify(raw, env.SESSION_SECRET) : null;
  return !!(payload && presented && payload.v === presented);
}

// ⚠️ `next` IS ATTACKER-SUPPLIED. `/auth/login?next=https://evil.example.com`
// renders that value into the sign-in form's hidden field and into the signed
// magic-link token, and it rides the OAuth `state` too — so a victim who signs
// in perfectly normally is redirected off-site the instant they succeed, with a
// session freshly issued. The cookie is HttpOnly and SameSite=Lax so it does
// not travel to the attacker, but "you are now signed in" followed by a page
// that is not this site is the entire phishing setup, and the victim has no
// reason to distrust it.
//
// ⚠️ Sanitised HERE because `land()` is the one choke point every provider
// funnels through — email, Google, GitHub. Validating at each call site is how
// a fourth provider added later arrives unprotected.
//
// Only a same-origin PATH survives. `//evil.com` is protocol-relative and would
// be treated as a host by the browser; `/\evil.com` is the same trick some
// parsers fall for. Anything else becomes '/'.
const safeNext = (next) => {
  const s = String(next ?? '');
  if (!s.startsWith('/')) return '/';
  if (s.startsWith('//') || s.startsWith('/\\')) return '/';
  return s;
};

async function land(env, person, next) {
  const token = await issue(person.sub, env);
  return redirect(safeNext(next), { 'set-cookie': cookie('collab_session', token) });
}

// A person the roster does not carry gets a plain refusal that does NOT say
// whether the address exists elsewhere.
const refused = () => html('<h1 style="margin-top:0">Not on this project</h1><p>That sign-in worked, but the address is not on this project’s roster. Ask whoever runs it to add you.</p>', 403);

// --- Google ---------------------------------------------------------------

async function googleStart(env, url) {
  const state = crypto.randomUUID();
  const next = url.searchParams.get('next') || '/';
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', await secretValue(env, 'GOOGLE_CLIENT_ID'));
  auth.searchParams.set('redirect_uri', `${url.origin}/auth/google/callback`);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email profile');
  auth.searchParams.set('state', `${state}|${next}`);
  const hd = await secretValue(env, 'GOOGLE_HOSTED_DOMAIN');
  if (hd) auth.searchParams.set('hd', hd);
  return redirect(auth.toString(), { 'set-cookie': await setState(env, `${state}|${next}`) });
}

async function googleCallback(request, env, url) {
  const state = url.searchParams.get('state');
  if (!(await checkState(request, env, state))) return html('<h1>Sign-in expired</h1><p>Start again from <a href="/auth/login">the sign-in page</a>.</p>', 400);
  const code = url.searchParams.get('code');
  if (!code) return html('<h1>No code returned</h1>', 400);

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: await secretValue(env, 'GOOGLE_CLIENT_ID'),
      client_secret: await secretValue(env, 'GOOGLE_CLIENT_SECRET'),
      redirect_uri: `${url.origin}/auth/google/callback`, grant_type: 'authorization_code',
    }),
  });
  if (!r.ok) return html('<h1>Google refused the exchange</h1>', 502);
  const { id_token } = await r.json();
  // The id_token came straight from Google's token endpoint over TLS, so its
  // signature adds nothing here. ⚠️ That stops being true the moment one is
  // accepted from anywhere else.
  const claims = JSON.parse(atob(String(id_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  const person = await findByEmail(env, claims.email);
  if (!person) return refused();
  return land(env, person, state.split('|').slice(1).join('|'));
}

// --- GitHub ---------------------------------------------------------------

async function githubStart(env, url) {
  const state = crypto.randomUUID();
  const next = url.searchParams.get('next') || '/';
  const auth = new URL('https://github.com/login/oauth/authorize');
  auth.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  auth.searchParams.set('redirect_uri', `${url.origin}/auth/github/callback`);
  auth.searchParams.set('scope', 'read:user user:email');
  auth.searchParams.set('state', `${state}|${next}`);
  return redirect(auth.toString(), { 'set-cookie': await setState(env, `${state}|${next}`) });
}

async function githubCallback(request, env, url) {
  const state = url.searchParams.get('state');
  if (!(await checkState(request, env, state))) return html('<h1>Sign-in expired</h1><p>Start again from <a href="/auth/login">the sign-in page</a>.</p>', 400);

  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code') }),
  });
  if (!r.ok) return html('<h1>GitHub refused the exchange</h1>', 502);
  const { access_token } = await r.json();
  const headers = { authorization: `Bearer ${access_token}`, 'user-agent': 'collab-site', accept: 'application/vnd.github+json' };

  const user = await fetch('https://api.github.com/user', { headers }).then((x) => x.json());
  let email = user.email;
  if (!email) {
    // A private primary address is the normal case, not an edge case.
    const list = await fetch('https://api.github.com/user/emails', { headers }).then((x) => x.json()).catch(() => []);
    email = (Array.isArray(list) ? list.find((e) => e.primary && e.verified) : null)?.email || null;
  }
  const person = await findByEmail(env, email);
  if (!person) return refused();
  return land(env, person, state.split('|').slice(1).join('|'));
}

// --- The CMS (a signed ticket from another domain; cms.js) -----------------

async function cmsStart(env, url) {
  const state = crypto.randomUUID();
  const next = url.searchParams.get('next') || '/';
  const go = new URL('/api/collab-pass/start', env.CMS_URL);
  go.searchParams.set('host', url.host);
  go.searchParams.set('state', state);
  // `next` stays HERE, in the signed state cookie: the CMS never sees where
  // the person was going, and cannot be made to send them anywhere else.
  return redirect(go.toString(), { 'set-cookie': await setState(env, `${state}|${next}`) });
}

async function cmsCallback(request, env, url) {
  const raw = readCookie(request, 'collab_state');
  const st = raw ? await verify(raw, env.SESSION_SECRET) : null;
  const [state, ...rest] = String(st?.v || '').split('|');
  const claims = await verifyTicket(url.searchParams.get('ticket'), cmsSecret(env), { host: url.host, state });
  if (!claims) return html('<h1>That sign-in did not check out</h1><p>It may have taken too long, or been started in another tab. Start again from <a href="/auth/login">the sign-in page</a>.</p>', 400);
  if (!(await burnTicket(env, claims.sig, claims.expires))) return html('<h1>That sign-in link was already used</h1><p>Start again from <a href="/auth/login">the sign-in page</a>.</p>', 400);
  const person = await findByEmail(env, claims.email);
  if (!person) return refused();
  return land(env, person, rest.join('|'));
}

// --- Magic link -----------------------------------------------------------

async function emailStart(request, env, url) {
  // Whether a sender is configured does not depend on who is asking, so this
  // can be answered plainly. Saying "check your email" when nothing can be sent
  // is a lie that costs somebody twenty minutes.
  // ⚠️ Resolved rather than read: an admin may have set this from /admin/settings,
  // and a stored value wins over the deploy-time one.
  const resendKey = String((await secretValue(env, 'RESEND_API_KEY')) || '').trim();
  if (!resendKey && !flag(env, 'MAGIC_LINK_TO_LOG')) {
    return html('<h1 style="margin-top:0">Email sign-in is not configured</h1><p>This instance has no sender set up yet.</p>', 503);
  }

  const form = await request.formData().catch(() => null);
  const email = String(form?.get('email') || '').trim().toLowerCase();
  const next = String(form?.get('next') || '/');

  // ⚠️ The same answer whether or not the address is on the roster. Anything
  // else turns the sign-in form into a way to ask who has access.
  const same = html('<h1 style="margin-top:0">Check your email</h1><p>If that address is on this project, a sign-in link is on its way. It lasts fifteen minutes.</p>');

  const person = await findByEmail(env, email);
  if (!person) return same;

  // Thirty minutes, not fifteen: mail is sometimes slow, and a link that dies
  // while it is still in transit is indistinguishable from one that never came.
  const token = await sign({ sub: person.sub, next, exp: Math.floor(Date.now() / 1000) + 1800 }, env.SESSION_SECRET);
  const link = `${url.origin}/auth/email/verify?t=${encodeURIComponent(token)}`;

  if (!resendKey) {
    // ⚠️ A sign-in link in a log is a sign-in link anybody with log access can
    // use. This is for local development and for bootstrapping an instance
    // before its sender exists, it must be switched on deliberately, and it
    // must be switched off again -- which is why the gate rejects it in a
    // committed config.
    console.log(`[magic link] ${email} -> ${link}`);
    return same;
  }

  // ⚠️ Neutral to the visitor, LOUD in the log. The person asking must not learn
  // whether the address is on the roster, but a send that Resend rejected --
  // an unverified sending domain, a bad key, a recipient it will not deliver to
  // while the account is in test mode -- has to say so somewhere, or the whole
  // failure is one person waiting for an email that was never accepted.
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      // ⚠️ Trimmed. A key copied from a dashboard carries a newline more often
      // than not, and `Bearer re_xxx\n` is rejected as an invalid header value --
      // which surfaces as an auth failure and sends you looking at the key.
      headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
      // ⚠️ A single-link HTML email from a new sending domain is close to a
      // textbook spam signature. A plain-text alternative, a display name, a
      // real reply-to and the URL in full all pull the score back -- none of
      // them is decoration.
      body: JSON.stringify({
        from: `${PROJECT.name} <${env.MAGIC_LINK_FROM}>`,
        to: [email],
        reply_to: (await secretValue(env, 'REPLY_TO')) || undefined,
        subject: `Your sign-in link for ${PROJECT.name}`,
        text: [
          `You asked to sign in to ${PROJECT.name}.`,
          '',
          'Open this link within thirty minutes:',
          link,
          '',
          'If you did not ask for this, nothing has happened and you can ignore it.',
        ].join('\n'),
        html: `<p>You asked to sign in to <strong>${PROJECT.name}</strong>.</p>
<p><a href="${link}">Sign in</a> \u2014 the link lasts thirty minutes.</p>
<p style="color:#666;font-size:13px">If the button does not work, paste this into your browser:<br>${link}</p>
<p style="color:#666;font-size:13px">If you did not ask for this, nothing has happened and you can ignore it.</p>`,
      }),
    });
    if (!r.ok) {
      console.error(`[magic link] Resend refused ${r.status} sending as "${env.MAGIC_LINK_FROM}": ${(await r.text()).slice(0, 400)}`);
    } else {
      // The id is what you search for in Resend's own Emails log, which is the
      // only place that says DELIVERED, bounced or dropped. "Accepted" only
      // means Resend took it; it is not the same as arrived.
      const body = await r.json().catch(() => ({}));
      console.log(`[magic link] Resend accepted id=${body.id || 'unknown'} from="${env.MAGIC_LINK_FROM}" to="${email}"`);
    }
  } catch (e) {
    console.error(`[magic link] could not reach Resend: ${e.message}`);
  }

  return same;
}

async function emailVerify(env, url) {
  const r = await inspect(url.searchParams.get('t'), env.SESSION_SECRET);
  if (!r.ok) {
    console.warn(`[magic link] rejected: ${r.reason}`);
    if (r.reason === 'expired') {
      return html('<h1 style="margin-top:0">That link has expired</h1><p>Links last thirty minutes. Ask for a new one from <a href="/auth/login">the sign-in page</a>.</p>', 400);
    }
    return html(`<h1 style="margin-top:0">That link is not valid</h1>
      <p>It has not expired \u2014 the signature does not match, which usually means the
      address was cut short or altered on its way here. <strong>Click the link in the
      email</strong> rather than copying it, and check nothing was appended to the end.</p>
      <p>Otherwise ask for a new one from <a href="/auth/login">the sign-in page</a>.</p>`, 400);
  }
  const payload = r.payload;
  // The token names a roster key. Re-read the roster rather than trusting the
  // token's own word, so somebody removed after the link was sent cannot use it.
  const who = await findByEmail(env, payload.sub);
  if (!who) return refused();
  return land(env, who, payload.next);
}

// --- router ---------------------------------------------------------------

export async function handleAuth(request, env, url) {
  const p = url.pathname;

  if (p === '/auth/login') return loginPage(env, url);
  if (p === '/auth/logout') {
    return redirect('/auth/login', { 'set-cookie': cookie('collab_session', '', { maxAge: 0 }) });
  }

  if (!env.SESSION_SECRET) return html('<h1>Sign-in is not configured</h1><p>This instance has no SESSION_SECRET.</p>', 503);

  const on = await enabled(env);
  if (p === '/auth/google/start' && on.google) return googleStart(env, url);
  if (p === '/auth/google/callback' && on.google) return googleCallback(request, env, url);
  if (p === '/auth/github/start' && on.github) return githubStart(env, url);
  if (p === '/auth/github/callback' && on.github) return githubCallback(request, env, url);
  if (p === '/auth/cms/start' && on.cms) return cmsStart(env, url);
  if (p === '/auth/cms/callback' && on.cms) return cmsCallback(request, env, url);
  if (p === '/auth/email/start' && on.email && request.method === 'POST') return emailStart(request, env, url);
  if (p === '/auth/email/verify' && on.email) return emailVerify(env, url);

  return html('<h1>No such sign-in method</h1><p>Back to <a href="/auth/login">the sign-in page</a>.</p>', 404);
}
