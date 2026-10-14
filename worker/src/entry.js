// The deployed entry point.
//
// ⚠️ Kept separate from index.js on purpose. `@cloudflare/workers-oauth-provider`
// imports `cloudflare:workers`, which Node cannot load — and every test in this
// suite imports index.js. Wiring the provider here means the tests exercise the
// real site handler without the deploy-only dependency coming with it.
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { siteHandler, MCP_HANDLERS } from './index.js';
import { enforceRetention } from './chat.js';
import { makeAuthorizeHandler, oauthMcpHandler } from './oauth.js';

// ⚠️ /mcp keeps its per-person bearer contract and is untouched — Claude Code
// and Claude Desktop use it, and putting it behind OAuth would break every
// existing .mcp.json. /connect is the same MCP server behind OAuth 2.1 + DCR,
// for claude.ai and mobile, which cannot send a static header.
const oauth = new OAuthProvider({
  apiRoute: '/connect',
  apiHandler: oauthMcpHandler,
  defaultHandler: makeAuthorizeHandler(siteHandler),
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['collab'],
});

export default {
  // The retention job. A period nothing enforces is a lie, so it runs on a
  // schedule rather than on somebody remembering.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(enforceRetention(env));
  },

  fetch(request, env, ctx) {
    // The MCP write paths are shared with the API so an agent can never do
    // something a person cannot; hand them to the OAuth route too.
    return oauth.fetch(request, { ...env, MCP_HANDLERS }, ctx);
  },
};
