// The route table, exported so the gate can resolve every /api/ call the pages
// make against routes that actually exist.
//
// ⚠️ This exists because of a real failure: a worksheet fetched `/api/me` when
// the server only had `/api/auth/user`, so an author-only button rendered for
// nobody, on production, looking like a design choice. A page asking an
// endpoint that does not exist fails silently by nature; only a test catches it.
export const ROUTES = [
  // ⚠️ `/` is a ROUTER, not a page. No file is built for it: the Worker sends a
  // first-time reader to /start/ and everybody else to /summary/. It is listed
  // here so the gate can resolve the brand link, which every page carries.
  { method: 'GET',   path: '/' },
  { method: 'GET',   path: '/api/me' },
  { method: 'GET',   path: '/api/answers' },
  { method: 'POST',  path: '/api/answers' },
  { method: 'PATCH', path: '/api/answers/:id' },
  { method: 'GET',   path: '/api/comments' },
  { method: 'POST',  path: '/api/comments' },
  { method: 'GET',   path: '/api/notifications' },
  { method: 'POST',  path: '/api/seen' },
  { method: 'POST',  path: '/mcp' },
  { method: 'GET',   path: '/auth/login' },
  { method: 'GET',   path: '/auth/logout' },
  { method: 'GET',   path: '/auth/google/start' },
  { method: 'GET',   path: '/auth/google/callback' },
  { method: 'GET',   path: '/auth/github/start' },
  { method: 'GET',   path: '/auth/github/callback' },
  { method: 'POST',  path: '/auth/email/start' },
  { method: 'GET',   path: '/auth/email/verify' },
  // The OAuth front door for claude.ai and mobile. /mcp keeps its bearer
  // contract; these are handled by the provider, not by the router below.
  { method: 'GET',   path: '/authorize' },
  { method: 'POST',  path: '/authorize' },
  { method: 'POST',  path: '/token' },
  { method: 'POST',  path: '/register' },
  { method: 'POST',  path: '/connect' },
  { method: 'GET',   path: '/api/admin/people' },
  { method: 'POST',  path: '/api/admin/people' },
  { method: 'PATCH', path: '/api/admin/people/:email' },
  { method: 'DELETE', path: '/api/admin/people/:email' },
  { method: 'GET',   path: '/api/admin/log' },
  { method: 'GET',    path: '/api/admin/secrets' },
  { method: 'PUT',    path: '/api/admin/secrets/:name' },
  { method: 'DELETE', path: '/api/admin/secrets/:name' },
  { method: 'POST',  path: '/api/chat' },
  { method: 'GET',   path: '/api/chat/sessions' },
  { method: 'GET',   path: '/api/chat/sessions/:id' },
];

export function matches(pathname) {
  return ROUTES.some((r) => {
    const a = r.path.split('/'), b = pathname.split('/');
    return a.length === b.length && a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
  });
}
