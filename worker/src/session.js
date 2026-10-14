// Sessions: a signed cookie, and nothing else.
//
// The roster is bundled with the deployment, so removing somebody and deploying
// revokes them on their next request -- there is no session store to sweep.
// `SESSION_EPOCH` invalidates everyone at once when that is what you want.

const enc = new TextEncoder();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function key(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function sign(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body)));
  return `${body}.${sig}`;
}

// Returns the payload, or a reason it was rejected.
//
// ⚠️ "Expired" and "not valid" must be DIFFERENT answers. Collapsing them into
// one message cost an hour: a link with thirteen minutes left on it reported
// itself expired, so the clock was investigated and the signature -- the actual
// failure -- was not. A diagnostic that names the wrong cause is worse than one
// that says nothing.
export async function inspect(token, secret) {
  if (!token || !token.includes('.')) return { ok: false, reason: 'malformed' };
  const [body, sig] = token.split('.');
  let signed = false;
  try {
    signed = await crypto.subtle.verify('HMAC', await key(secret), unb64url(sig), enc.encode(body));
  } catch { return { ok: false, reason: 'malformed' }; }
  if (!signed) return { ok: false, reason: 'signature' };
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(unb64url(body))); } catch { return { ok: false, reason: 'malformed' }; }
  // An expiry that is not checked is a comment.
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired', payload };
  return { ok: true, payload };
}

export async function verify(token, secret) {
  const r = await inspect(token, secret);
  return r.ok ? r.payload : null;
}

const DAYS_30 = 60 * 60 * 24 * 30;

export async function issue(sub, env, seconds = DAYS_30) {
  return sign({ sub, epoch: env.SESSION_EPOCH || '1', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + seconds }, env.SESSION_SECRET);
}

export function cookie(name, value, { maxAge = DAYS_30, secure = true } = {}) {
  const bits = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function readCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
