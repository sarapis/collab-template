// Secrets an admin can set from the site, instead of from a terminal.
//
// ⚠️ TWO OF THE FIVE CANNOT MOVE, and the reasons are structural rather than
// cautious:
//   SESSION_SECRET  verifies the session that authenticates the admin who would
//                   be changing it. Storing it behind itself is circular, and
//                   rotating it from inside would sign you out mid-request.
//   ROOT_ADMIN      is the bootstrap. It has to work when the users table is
//                   empty or lost, which is exactly when the database cannot be
//                   the place it is kept.
// A third, CLOUDFLARE_API_TOKEN, is not a Worker secret at all: it is what lets
// CI deploy, and it lives on the repository.
//
// ⚠️ THE WORKER MUST NEVER HOLD A CREDENTIAL MORE POWERFUL THAN THE ONES IT IS
// PROTECTING. The obvious implementation — give the Worker a Cloudflare API
// token so it can write real Worker secrets — hands a public endpoint a
// credential that can redeploy the Worker itself. That is a larger hole than
// the inconvenience it fixes. So the values live in D1, encrypted.
//
// ⚠️ ENCRYPTED, not stored plainly. D1 also holds answers, comments and the
// roster, and it is read by wrangler, by the admin API and by any future export
// script. Ciphertext means a database dump on its own yields nothing; the key
// stays a deploy-time secret. You cannot get to zero deploy-time secrets —
// SETTINGS_KEY is the floor, and the point is that it is the ONLY one an
// operator has to think about after the first deploy.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

// ⚠️ A FIXED ALLOWLIST, never "any name the caller sends". Without it an admin
// could set PUBLIC_READ, or ROOT_ADMIN, and quietly take the site over or lock
// its owner out through a form meant for an API key.
export const MANAGEABLE = {
  GEMINI_API_KEY: { describes: 'The assistant. Without it the assistant says it has no key.' },
  RESEND_API_KEY: { describes: 'Sends sign-in links. Without it nobody new can sign in.' },
  AGENT_TOKENS: { describes: 'Bearer tokens for Claude Code, as {"they@example.org":"sha256:..."}.' },
  GOOGLE_CLIENT_SECRET: { describes: 'Google sign-in. Set this and the ID, and the button appears.' },

  // ⚠️ `public: true` is OPT-IN, and the default is secret. A setting added
  // later and not thought about stays masked and unreadable — the failure of
  // forgetting is a field that is more private than it needed to be, never one
  // that shows a key. Only mark something public when it is public BY NATURE:
  //   REPLY_TO             an address, already visible to any admin on /admin/people
  //   GOOGLE_CLIENT_ID     appears in the OAuth redirect in every visitor's browser
  //   GOOGLE_HOSTED_DOMAIN a domain name
  // A value that is merely "not very sensitive" does not qualify.
  REPLY_TO: { describes: 'Reply-to address on sign-in mail. Deliberately not in the repository.', public: true },
  GOOGLE_CLIENT_ID: { describes: 'Google sign-in. Needs the callback URL registered in Google Cloud Console.', public: true },
  GOOGLE_HOSTED_DOMAIN: { describes: 'Optional: restrict Google sign-in to one Workspace domain.', public: true },
};
async function aesKey(env) {
  const raw = String(env.SETTINGS_KEY || '');
  // ⚠️ FAIL CLOSED. A short or missing key must not fall back to storing the
  // value in the clear: that would be a feature quietly downgrading itself into
  // the thing it exists to avoid.
  if (raw.length < 32) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function putSecret(env, name, value, actor) {
  if (!(name in MANAGEABLE)) return { ok: false, error: 'not a manageable setting' };
  const text = String(value ?? '').trim();
  if (!text) return { ok: false, error: 'value required' };
  const key = await aesKey(env);
  if (!key) return { ok: false, error: 'This instance has no SETTINGS_KEY, so a value cannot be stored safely.' };

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  await env.DB.prepare(
    `INSERT INTO app_secrets (name, iv, value, set_at, set_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, value = excluded.value, set_at = excluded.set_at, set_by = excluded.set_by`
  ).bind(name, b64(iv), b64(cipher), new Date().toISOString(), actor).run();
  return { ok: true };
}

export async function clearSecret(env, name) {
  if (!(name in MANAGEABLE)) return { ok: false, error: 'not a manageable setting' };
  await env.DB.prepare('DELETE FROM app_secrets WHERE name = ?').bind(name).run();
  return { ok: true };
}

// ⚠️ A stored value WINS over the deploy-time one. Setting something in the
// admin screen and having it silently not take effect is worse than not
// offering the screen: the operator would have no way to tell which value the
// site is using.
export async function secretValue(env, name) {
  const row = await env.DB?.prepare('SELECT iv, value FROM app_secrets WHERE name = ?')
    .bind(name).first().catch(() => null);
  if (row) {
    const key = await aesKey(env);
    if (key) {
      try {
        const clear = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: unb64(row.iv) }, key, unb64(row.value));
        return new TextDecoder().decode(clear);
      } catch {
        // A wrong SETTINGS_KEY must not look like "no value set". Say so.
        console.error(`[secrets] ${name} is stored but could not be decrypted: SETTINGS_KEY has changed`);
        return undefined;
      }
    }
  }
  return env[name];
}

// ⚠️ Returns a value ONLY for a setting marked `public` in MANAGEABLE. For
// everything else it reports whether one is set, where it came from and who set
// it, and nothing more: an admin screen that can show a key back is a screen
// that leaks every key to anyone who reaches it once.
//
// The distinction is not "sensitive" versus "not". It is whether the value is
// already visible elsewhere by design — an address an admin can read on the
// people page, a client id that appears in every visitor's OAuth redirect.
export async function listSecrets(env) {
  const { results } = await env.DB.prepare('SELECT name, set_at, set_by FROM app_secrets').all().catch(() => ({ results: [] }));
  const stored = new Map((results || []).map((r) => [r.name, r]));
  const out = [];
  for (const [name, meta] of Object.entries(MANAGEABLE)) {
    const row = stored.get(name);
    const entry = {
      name,
      describes: meta.describes,
      public: !!meta.public,
      source: row ? 'stored' : (env[name] ? 'deploy' : 'none'),
      set_at: row?.set_at || null,
      set_by: row?.set_by || null,
    };
    // ⚠️ The ONLY branch in this file that can put a value in a response.
    if (meta.public && entry.source !== 'none') entry.value = (await secretValue(env, name)) ?? null;
    out.push(entry);
  }
  return out;
}

export async function handleSecrets(request, env, me, name) {
  const method = request.method.toUpperCase();
  if (method === 'GET') return json({ secrets: await listSecrets(env), configurable: !!(await aesKey(env)) });
  if (method === 'PUT') {
    const body = await request.json().catch(() => null);
    const r = await putSecret(env, name, body?.value, me.email);
    return r.ok ? json({ ok: true }) : json({ error: r.error }, 400);
  }
  if (method === 'DELETE') {
    const r = await clearSecret(env, name);
    return r.ok ? json({ ok: true }) : json({ error: r.error }, 400);
  }
  return json({ error: 'method not allowed' }, 405);
}
