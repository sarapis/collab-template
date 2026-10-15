// One identity interface. Where an identity comes from is configuration, and
// every mode has an agent path -- the answer to "an agent cannot get in" must
// never be "paste the password into a chat".
//
// ⚠️ Who somebody IS comes from the database now (worker/src/people.js), not
// from a list in the repository. The provider still only proves an email
// address; the roster still decides whether that means anything here. Only the
// place the roster lives has changed.

import { verify, readCookie } from './session.js';
import { flag } from './flag.js';
import { findByEmail } from './people.js';
import { secretValue } from './secrets.js';

export const ANON = { authenticated: false, can_write: false, sub: null, name: null, audiences: [], role: null };

// Whether this caller may READ anything at all.
//
// ⚠️ ONE rule for THREE doors — pages, /api/ and MCP. It used to be written
// inline at two of them and simply missing at the third, and the third served
// every stored answer on a private instance to anyone who could guess a
// question slug (they are `<project>:<slug>`, so guessing is not the hard
// part). Two correct copies and one absent copy is indistinguishable from
// three correct copies until somebody checks, which is why this is a function
// and not a habit.
//
// `item`, when given, is one piece of content with a per-item `status`
// (version.js; content as rows). The same rule, narrowed:
//   members   only somebody on the roster, even on a public instance
//   draft     only an editor (it is never compiled; a preview shows one)
// Anything else reads as the site does. ⚠️ A status this function does not know
// is refused: the safe reading of a visibility you do not understand is "not you".
const ITEM_STATUSES = new Set(['published', 'archived', 'members', 'draft']);
export const isEditor = (me) => !!me?.authenticated && !me.disabled && (me.role === 'admin' || me.role === 'contributor');
export const canRead = (env, me, item) => {
  const site = flag(env, 'PUBLIC_READ') || !!me?.authenticated;
  if (!site || item === undefined) return site;
  const status = item?.status ?? 'published';
  if (!ITEM_STATUSES.has(status)) return false;
  if (status === 'members') return !!me?.authenticated;
  if (status === 'draft') return isEditor(me);
  return true;
};

// Constant-time compare. An unknown token must take the same path as a known
// one, or the timing enumerates who has access.
async function tokenMatches(presented, expectedHex) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(presented));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  let diff = hex.length ^ expectedHex.length;
  for (let i = 0; i < Math.max(hex.length, expectedHex.length); i++) {
    diff |= (hex.charCodeAt(i % hex.length) ^ expectedHex.charCodeAt(i % expectedHex.length));
  }
  return diff === 0;
}

// A 32-byte random token is NOT a password and needs no stretching. Cost-14
// bcrypt is ~1s of CPU by design and Worker CPU is metered -- the exact trap
// ops-mcp-worker hit and backed out of.
//
// ⚠️ Tokens are keyed by EMAIL, so a token resolves to the same person the
// session does. Two ways of naming the same human is how they drift apart.
async function fromBearer(env, header) {
  const presented = (header || '').replace(/^Bearer\s+/i, '');
  if (!presented) return null;
  let tokens = {};
  try { tokens = JSON.parse((await secretValue(env, 'AGENT_TOKENS')) || '{}'); } catch { return null; }
  let found = null;
  for (const [email, hash] of Object.entries(tokens)) {
    const hit = await tokenMatches(presented, String(hash).replace(/^sha256:/, ''));
    if (hit && !found) found = email;
  }
  if (!found) return null;
  const who = await findByEmail(env, found);
  return who && !who.disabled ? { ...who, via: 'agent' } : null;
}

export async function identify(request, env) {
  const bearer = await fromBearer(env, request.headers.get('authorization'));
  if (bearer) return bearer;

  // A signed session cookie issued by one of the providers in auth.js.
  const raw = readCookie(request, 'collab_session');
  if (raw && env.SESSION_SECRET) {
    const payload = await verify(raw, env.SESSION_SECRET);
    // ⚠️ The roster is re-read on every request, not trusted from the cookie.
    // Removing somebody revokes them on their next request; a session carrying
    // its own permissions would outlive the decision to take them away.
    if (payload && String(payload.epoch) === String(env.SESSION_EPOCH || '1')) {
      const who = await findByEmail(env, payload.sub);
      if (who && !who.disabled) return { ...who, via: 'session' };
    }
  }

  // Tests and local development sign in by email with no signing secret.
  // ⚠️ MUST be switched on deliberately, not merely left on by a missing secret:
  // the window between deploying and setting SESSION_SECRET would otherwise
  // accept anybody who named themselves in a cookie.
  if (flag(env, 'DEV_SIGN_IN') && !env.SESSION_SECRET && raw) {
    const who = await findByEmail(env, raw);
    if (who && !who.disabled) return { ...who, via: 'session' };
  }

  if (flag(env, 'PUBLIC_READ')) return { ...ANON, can_read: true };
  return ANON;
}

export { findByEmail };
