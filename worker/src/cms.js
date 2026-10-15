// "Sign in with the CMS": a CMS on another domain hands identity across as a
// signed, short-lived TICKET (v1.2.0).
//
// The pattern is Civic-Tech-Field-Guide/ctfg-website's tenant pass
// (payload/src/tenant-pass.ts mints, deploy/api/src/tenant-pass.mjs verifies),
// with its own kind of ticket:
//
//   1. /auth/cms/start sends the browser to the CMS:
//        <CMS_URL>/api/collab-pass/start?host=<this host>&state=<random>
//   2. The CMS sees its own login (its cookie never leaves its host) and
//      redirects back with a ticket naming the email it knows:
//        https://<this host>/auth/cms/callback?ticket=v1.<claims>.<mac>
//   3. This file verifies the ticket; auth.js asks the ROSTER whether that
//      email means anything here.
//
// Format: `v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, "v1.<body>"))>`,
// claims { k: 'collab-identity', m: email, h: host, s: state, e: expiry (unix s) }.
//
// ⚠️ It proves an email and nothing else. Whether the CMS thinks the person is
// an admin, a curator or nobody is not read: the roster in D1 authorizes.
// ⚠️ Every check below is a refusal, and the order does not matter: a ticket
// for another host, another sign-in attempt (state), past its time, of another
// kind, or already used is refused, whoever signed it.

export const TICKET_KIND = 'collab-identity';
// The CMS mints for two minutes; anything claiming longer is refused, so a
// misconfigured or compromised minter cannot issue a long-lived login.
export const MAX_TTL_S = 300;

const b64urlToBytes = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export function cmsSecret(env) {
  const s = String(env.CMS_PASS_SECRET || '').trim();
  return s.length >= 32 ? s : '';
}

export const cmsEnabled = (env) => !!(cmsSecret(env) && /^https:\/\/[^/]+/.test(String(env.CMS_URL || '')));

async function mac(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v1.${body}`)));
}

// The claims, or null. Never throws: a verifier that can be made to throw is
// one whose caller might catch it and carry on.
export async function verifyTicket(token, secret, { host, state, now = Math.floor(Date.now() / 1000) } = {}) {
  try {
    if (!secret || typeof token !== 'string' || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
    const want = await mac(secret, parts[1]);
    const got = b64urlToBytes(parts[2]);
    if (got.length !== want.length) return null;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
    if (diff !== 0) return null;
    const c = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (!c || typeof c !== 'object' || c.k !== TICKET_KIND) return null;
    if (typeof c.m !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(c.m)) return null;
    if (typeof c.e !== 'number' || c.e <= now || c.e > now + MAX_TTL_S) return null;
    if (typeof c.h !== 'string' || c.h.toLowerCase() !== String(host || '').toLowerCase()) return null;
    if (typeof c.s !== 'string' || !c.s || c.s !== state) return null;
    return { email: c.m.trim().toLowerCase(), expires: c.e, sig: parts[2] };
  } catch {
    return null;
  }
}

// One use per ticket: the ticket rides in a URL (history, logs, a Referer), so a
// second presentation inside its two minutes is refused. D1, not KV: a
// once-only check read from an eventually consistent store is not once-only.
export async function burnTicket(env, sig, expires) {
  await env.DB.prepare('DELETE FROM auth_tickets_used WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)).run().catch(() => {});
  try {
    await env.DB.prepare('INSERT INTO auth_tickets_used (sig, expires_at) VALUES (?, ?)').bind(sig, expires).run();
    return true;
  } catch {
    return false;
  }
}

// For tests and for documenting the format: the minting half, as the CMS does it.
export async function signTicket(claims, secret) {
  const body = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const m = await mac(secret, body);
  return `v1.${body}.${btoa(String.fromCharCode(...m)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
