// The OAuth 2.1 + Dynamic Client Registration front door.
//
// Claude Code and Claude Desktop reach /mcp directly with a per-person bearer
// token and need none of this. claude.ai and the Claude mobile app speak OAuth
// 2.1 with DCR: a bare 401 and no discovery document leaves them nothing to
// register against, and what a person sees is "Couldn't register with …'s
// sign-in service" — a message that names neither OAuth nor the cause, and gets
// reported as an outage.
//
// ⚠️ Extracted from ctfg-directory/ops-mcp-worker, which was written and
// verified end to end. One thing is deliberately different. That worker had to
// ask for a name and password at /authorize, because the box owned identity and
// the worker held none. Here the Worker IS the identity authority, so this is a
// consent screen over a session that already exists — nobody types a password
// into a second place, and there is still exactly one roster.

import { findByEmail } from './identity.js';
import { verify, readCookie } from './session.js';
import { handleMcp } from './mcp.js';
import { PROJECT } from './site.generated.js';

const page = (body, status = 200) =>
  new Response(`<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect</title>
<link rel="stylesheet" href="/tokens.css">
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;
    background:var(--background);color:var(--foreground);
    font-family:var(--font-sans);line-height:1.6}
  .box{width:100%;max-width:27rem;padding:2.5rem 2.4rem;border:1px solid var(--border);
    border-radius:calc(var(--radius) * 1.6);background:var(--card);box-shadow:var(--shadow-card)}
  h1{font-family:var(--font-serif);font-weight:600;font-size:1.5rem;letter-spacing:-.015em;
    margin:0 0 .3rem;line-height:1.2}
  .tagline{color:var(--foreground);font-size:.95rem;margin:.1rem 0 .9rem}
  p{font-size:.92rem}
  .muted{color:var(--muted-foreground);font-size:.85rem}
  ul{font-size:.9rem;padding-left:1.1rem;margin:.6rem 0 1.2rem}
  li{margin:.25rem 0}
  .btn{display:block;width:100%;text-align:center;font:inherit;font-size:.94rem;
    font-weight:500;cursor:pointer;padding:.7rem 1rem;margin:.55rem 0;
    border-radius:var(--radius);border:1px solid var(--primary);
    background:var(--primary);color:var(--primary-foreground)}
  .btn.secondary{background:var(--card);color:var(--foreground);border-color:var(--border);
    text-decoration:none;display:block}
  .btn:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
  .rule{border:0;border-top:1px solid var(--border);margin:1.4rem 0 1rem}
</style></head><body><main class="box">${body}</main></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Who is asking, from the session cookie this site already issues.
async function currentPerson(request, env) {
  const raw = readCookie(request, 'collab_session');
  if (!raw || !env.SESSION_SECRET) return null;
  const payload = await verify(raw, env.SESSION_SECRET);
  if (!payload || String(payload.epoch) !== String(env.SESSION_EPOCH || '1')) return null;
  // ⚠️ A disabled person is on the roster and is nobody, as in identify().
  const who = await findByEmail(env, payload.sub);
  return who && !who.disabled ? who : null;
}

function consentPage(me, clientName, search) {
  return page(`
    <h1>${esc(PROJECT.name)}</h1>
    ${PROJECT.tagline ? `<p class="tagline">${esc(PROJECT.tagline)}</p>` : ''}
    <hr class="rule">
    <p><strong>${esc(clientName || 'An application')}</strong> is asking to connect
      to this project as <strong>${esc(me.name)}</strong>.</p>
    <p class="muted">It will be able to:</p>
    <ul>
      <li>read the documents, the question catalog and the answers</li>
      <li>read comments and the assistant's conversation log</li>
      <li>post answers and replies <strong>as you</strong></li>
    </ul>
    <p class="muted">It cannot change a document, resolve a question, or alter who
      may sign in — those are commits in the repository.</p>
    <form method="post" action="/authorize${search}">
      <button class="btn" type="submit" name="approve" value="yes">Connect as ${esc(me.name)}</button>
    </form>
    <a class="btn secondary" href="/">Cancel</a>
  `);
}

// Everything that is not the OAuth-fronted MCP route.
export function makeAuthorizeHandler(siteHandler) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname !== '/authorize') return siteHandler.fetch(request, env, ctx);

      const me = await currentPerson(request, env);
      if (!me) {
        // Send them through the sign-in this site already has, and bring them
        // back to the authorization they were in the middle of.
        const next = url.pathname + url.search;
        return new Response(null, {
          status: 302,
          headers: { location: `/auth/login?next=${encodeURIComponent(next)}` },
        });
      }

      const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);

      if (request.method === 'GET') {
        // ⚠️ The NAME, not the id. Showing the raw client id asked the person to
        // approve "zGcMJjHeGlvmGS5Z", which tells them nothing about what they
        // are connecting and trains them to approve anything.
        const client = await env.OAUTH_PROVIDER.lookupClient?.(authReq.clientId).catch(() => null);
        const name = client?.clientName || client?.client_name || authReq.clientId;
        return consentPage(me, name, url.search);
      }

      if (request.method === 'POST') {
        const form = await request.formData().catch(() => null);
        if (form?.get('approve') !== 'yes') {
          return new Response(null, { status: 302, headers: { location: '/' } });
        }
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: authReq,
          userId: me.sub,
          metadata: { label: `${PROJECT.name} — ${me.name}` },
          scope: authReq.scope ?? ['collab'],
          // ⚠️ Only the roster key is carried. The token must not embed the
          // person's permissions: the roster is re-read on every call, so
          // removing somebody and deploying revokes a connector they already
          // authorised.
          props: { sub: me.sub },
        });
        return Response.redirect(redirectTo, 302);
      }

      return new Response('Method not allowed', { status: 405 });
    },
  };
}

// The MCP endpoint behind OAuth. Identity comes from the token's props and is
// resolved against the roster exactly as the bearer path does, so both doors
// lead to the same person and the same permissions.
export const oauthMcpHandler = {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    const sub = ctx?.props?.sub;
    const me = sub ? await findByEmail(env, sub) : null;
    if (!me || me.disabled) {
      console.warn(`[oauth] a token names "${sub}", who is not on the roster`);
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32001, message: 'This connection is no longer authorised.' },
      }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    if (!env.MCP_HANDLERS) {
      console.error('[oauth] MCP_HANDLERS is missing from env; the write tools cannot run');
    }
    return handleMcp(request, env, { ...me, via: 'oauth' }, env.MCP_HANDLERS || {});
  },
};
