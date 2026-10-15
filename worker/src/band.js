// The band layout's pages, and the one read path every door shares.
//
// `site.layout: band` (worker/src/settings.js). The Worker renders the pages
// made from the content per viewer, from the live version (version.js), and
// wraps the pages Eleventy built (admin, design, notifications) in the same
// layout. `site.layout: classic` never reaches this file.
//
// ⚠️ viewEnv() is THE read path. It hands a handler an `ASSETS` whose
// /manifest.json, /sections.json and /source/... are the live version AS THIS
// VIEWER MAY SEE IT. Pages, /api/, /mcp, /connect and the assistant all read
// content through it, so a members-only document is removed in one place
// (forViewer) and a door added later inherits that by reading the way the
// others do. A handler that read env.ASSETS directly would see the build.
import { HOST } from './site.generated.js';
import { liveVersion, forViewer, statusOf, sourceByPath, readVersion, liveId, realAssets, markWrapped, isWrapped } from './version.js';
import { canRead } from './identity.js';
import { flag } from './flag.js';
import * as R from './render.js';

export const hostOf = (env) => env.COLLAB_HOST || HOST;
export const isBand = (env) => hostOf(env)?.settings?.layout === 'band';

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
// ⚠️ Every page the Worker renders is per viewer, so none may be cached by
// anything between the Worker and the reader (Databook decision 39).
const page = (html, status = 200) => new Response(html, {
  status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const redirect = (to, status = 301) => new Response(null, { status, headers: { location: to, 'cache-control': 'no-store' } });
const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

// What this viewer may see of the live version. Memoized on the request.
const views = new WeakMap();
export async function viewFor(request, env, me) {
  if (views.has(request)) return views.get(request);
  const host = hostOf(env);
  const p = (async () => {
    const version = await liveVersion(env, request, host.settings);
    return version ? { version, view: forViewer(version, env, me) } : null;
  })();
  views.set(request, p);
  return p;
}


function viewAssets(env, request, me) {
  const real = realAssets(env.ASSETS);
  const view = {
    async fetch(input, init) {
      const req = input instanceof Request ? input : new Request(input, init);
      const p = new URL(req.url).pathname;
      if (p === '/manifest.json' || p === '/sections.json' || p.startsWith('/source/')) {
        const v = await viewFor(request, env, me);
        if (!v) return new Response('no version', { status: 404 });
        if (p === '/manifest.json') return json(v.view.manifest);
        if (p === '/sections.json') return json(v.view.sections || {});
        const text = sourceByPath(v.view, decodeURIComponent(p.slice('/source/'.length)));
        return text == null ? notFound() : new Response(text, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } });
      }
      if (p.startsWith('/_build/')) return notFound();
      return real ? real.fetch(req) : new Response('no assets bound', { status: 500 });
    },
  };
  markWrapped(view, real);
  return view;
}

// The environment a handler reads content through. Classic: unchanged.
export function viewEnv(request, env, me) {
  if (!isBand(env) || isWrapped(env.ASSETS)) return env;
  return { ...env, ASSETS: viewAssets(env, request, me) };
}

// --- live data the pages show ---------------------------------------------

async function waitingFor(env, m, me) {
  if (!me?.authenticated) return null;
  const mine = m.questions.filter((q) => !q.resolved && !q.hidden && (me.audiences || []).includes(q.audience));
  if (!mine.length) return 0;
  const { results } = await env.DB.prepare('SELECT question_id, MAX(created_at) AS latest FROM answers WHERE author_sub = ? GROUP BY question_id')
    .bind(me.sub).all().catch(() => ({ results: [] }));
  const opened = (q) => m.asked_rounds?.[q.asked]?.opened || '1970-01-01T00:00:00.000Z';
  return mine.filter((q) => !(results || []).some((r) => r.question_id === q.id && r.latest >= opened(q))).length;
}

export async function versionsList(env, settings, version, limit = 20) {
  if (settings.content.source !== 'rows') return version ? [{ ...version, live: true }] : [];
  const live = await liveId(env);
  const { results } = await env.DB.prepare('SELECT id, digest, created_at, created_by_name, reason FROM site_versions ORDER BY id DESC LIMIT ?')
    .bind(limit).all().catch(() => ({ results: [] }));
  return (results || []).map((r) => ({ id: r.id, digest: r.digest, published_at: r.created_at, published_by: r.created_by_name, reason: r.reason, live: r.id === live }));
}

async function activityLive(env, settings, version, view) {
  const ids = new Set(view.manifest.questions.map((q) => q.id));
  const docs = new Set(view.manifest.docs.map((d) => d.slug));
  const [a, c] = await Promise.all([
    env.DB.prepare('SELECT question_id, author_name, body, created_at FROM answers ORDER BY created_at DESC LIMIT 50').all().catch(() => ({ results: [] })),
    env.DB.prepare('SELECT doc, author_name, body, created_at FROM comments ORDER BY created_at DESC LIMIT 50').all().catch(() => ({ results: [] })),
  ]);
  return {
    answers: (a.results || []).filter((r) => ids.has(r.question_id)),
    comments: (c.results || []).filter((r) => !r.doc || docs.has(r.doc)),
    versions: await versionsList(env, settings, version),
  };
}

// --- the pages --------------------------------------------------------------

export function ctxFor(env, view) {
  const host = hostOf(env);
  return { version: view, project: view.manifest.project || {}, settings: host.settings, navArtifacts: host.nav_artifacts, chat: host.chat };
}

const docTitle = (view, slug) => view.manifest.docs.find((d) => d.slug === slug)?.title || slug;

// A page of the site for this viewer, or null to fall through to the assets.
export async function bandPage(request, env, me, url) {
  const host = hostOf(env);
  const p = url.pathname;
  if (p.startsWith('/_build/')) return notFound();

  // Databook decision 29: About replaces Start here and the Summary.
  // Decision 35: Decisions are a type of Activity.
  if (p === '/start/' || p === '/start' || p === '/summary/' || p === '/summary') return redirect('/about/');
  if (p === '/decisions/' || p === '/decisions') return redirect('/activity/?type=decisions');

  const pages = ['/', '/about/', '/get-involved/', '/questions/', '/activity/'];
  const v = await viewFor(request, env, me);
  if (!v) return null;
  const { version, view } = v;
  const ctx = ctxFor(env, view);
  const render = (title, body, extra = {}) => page(R.layout(ctx, { path: p, title, body, ...extra }));

  if (p === '/manifest.json' || p === '/sections.json' || p.startsWith('/source/')) return viewAssets(env, request, me).fetch(new Request(url));
  if (p === '/') return render(view.manifest.project?.name || 'Home', R.homePage(view, { waiting: await waitingFor(env, view.manifest, me) }));
  if (p === '/about/') return render('About', R.aboutPage(view), { doc: 'start' });
  if (p === '/get-involved/') return render('Get involved', R.getInvolvedPage(view, { origin: url.origin, publicRead: flag(env, 'PUBLIC_READ') }));
  if (p === '/questions/') return render('Questions', R.questionsPage(view));
  if (p === '/activity/') return render('Activity', R.activityPage(view, await activityLive(env, host.settings, version, view), url.searchParams.get('type')));
  if (pages.includes(p + '/')) return redirect(p + '/' + url.search);

  // A document. ⚠️ One that exists but this viewer may not see answers exactly
  // as one that does not exist: a 404 that differs would say it is there.
  const slug = p.replace(/^\/|\/$/g, '');
  const full = version.manifest.docs.find((d) => d.slug === slug && !d.partial);
  if (full) {
    if (!p.endsWith('/')) return redirect(p + '/' + url.search);
    const status = statusOf(version, slug);
    if (!canRead(env, me, { status })) return notFound();
    const d = view.manifest.docs.find((x) => x.slug === slug);
    const crumb = d.type === 'decision' ? { href: '/activity/?type=decisions', label: 'Decisions' }
      : d.type === 'post' ? { href: '/activity/?type=posts', label: 'Activity' } : null;
    return render(d.title, R.docPage(view, slug), { doc: slug, status: status === 'published' ? null : status, crumb });
  }
  return null;
}

// A page Eleventy built for the band layout: `<!--collab:band {...}-->` and the
// page's own content. Wrapped here so every page has one layout.
export async function wrapBuilt(response, request, env, me, url) {
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !type.includes('text/html')) return response;
  const text = await response.text();
  const m = text.match(/^<!--collab:band (\{[\s\S]*?\})-->\n?/);
  if (!m) return new Response(text, response);
  const meta = JSON.parse(m[1]);
  const v = await viewFor(request, env, me);
  if (!v) return new Response(text, response);
  return page(R.layout(ctxFor(env, v.view), { path: url.pathname, title: meta.title || '', doc: meta.doc || '', body: text.slice(m[0].length) }));
}

// /llms.txt on a public rows instance: built from what an anonymous reader sees.
export async function publicIndexFor(request, env, anon) {
  const v = await viewFor(request, env, anon);
  return v ? R.publicIndex(v.view, hostOf(env).public) : null;
}

export { readVersion };
