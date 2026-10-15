// Content as rows (`content.source: rows`; Databook decisions 37 to 40).
//
// The documents, About (README.md) and the question lock are rows in D1
// (schema.sql `content_items`). A SAVE:
//   1. reads every row, applies the edit in memory,
//   2. writes the rows back into the file tree the compiler reads, leaving out
//      drafts (a draft document, and a draft question inside a document),
//   3. compiles that tree here, with the same compiler the CLI runs,
//   4. if it fails: nothing is written, and the errors go back to the editor;
//      if it compiles: ONE batch writes the row, its revision, the lock if it
//      moved, the new version and the live pointer. All or nothing.
// A ROLLBACK moves the pointer to an earlier version and changes no row.
//
// ⚠️ The Worker never holds a git credential. Git gets the rows from the
// nightly export Action, which reads GET /api/content/export with its own
// read-only token (EXPORT_TOKEN) and writes the target repository itself.
import { compileFiles } from '../../packages/compile/src/core.js';
import { CONFIG_TEXT } from './site.generated.js';
import { digestOf, liveId, readVersion, liveVersion } from './version.js';
import { isEditor, canRead } from './identity.js';
import { hostOf, ctxFor, versionsList } from './band.js';
import * as R from './render.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const now = () => new Date().toISOString();

export const LOCK = 'content/questions.lock';
export const STATUSES = ['published', 'members', 'draft', 'archived'];
// ⚠️ D1 refuses a row over 2,000,000 bytes. A version that would not fit is
// refused with a sentence, not a D1 error nobody can read.
const MAX_PAYLOAD = 1_900_000;

const configText = (env) => env.COLLAB_CONFIG_TEXT ?? CONFIG_TEXT;

export const slugOf = (path) => (path === 'README.md' ? 'start'
  : path.replace(/^content\//, '').replace(/\.md$/, '').replace(/\/index$/, ''));

export function validPath(path) {
  return path === 'README.md'
    || (/^content\/[a-z0-9][a-z0-9/_-]*\.md$/.test(path) && !path.includes('//') && !path.includes('..'));
}

// --- question blocks ---------------------------------------------------------
// `:::question{...}` ... `:::`, found line by line the way the compiler's
// container rule finds them (packages/compile/src/questions.js).
const OPEN = /^( {0,3})(:{3,})\s*question(?=\s|\{|$)(.*)$/;

export function questionBlocks(body) {
  const lines = String(body).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPEN);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && !new RegExp(`^ {0,3}:{${m[2].length},}\\s*$`).test(lines[end])) end++;
    const braces = m[3].match(/\{([\s\S]*)\}\s*$/);
    out.push({ start: i, end: Math.min(end, lines.length - 1), attrsText: braces ? braces[1] : '', attrs: parseAttrs(braces ? braces[1] : '') });
    i = end;
  }
  return { lines, blocks: out };
}

function parseAttrs(raw) {
  const out = [];
  const re = /([A-Za-z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s}]+)/g;
  let m;
  while ((m = re.exec(raw))) out.push([m[1], m[3] ?? m[4] ?? m[2]]);
  return out;
}
const attr = (b, k) => b.attrs.find(([x]) => x === k)?.[1];
const isDraft = (b) => attr(b, 'draft') === 'true';

// The body the compiler sees: draft questions removed. Returns them too.
export function stripDrafts(body) {
  const { lines, blocks } = questionBlocks(body);
  const drafts = blocks.filter(isDraft);
  if (!drafts.length) return { body, drafts: [] };
  const drop = new Set();
  for (const b of drafts) for (let i = b.start; i <= b.end; i++) drop.add(i);
  return {
    body: lines.filter((_, i) => !drop.has(i)).join('\n'),
    drafts: drafts.map((b) => ({ slug: attr(b, 'slug'), text: lines.slice(b.start, b.end + 1).join('\n') })),
  };
}

const quote = (v) => (/^[^\s"'}]+$/.test(v) ? v : `"${String(v).replace(/"/g, "'")}"`);

// A question's status, as its attributes: open (none of these), resolved
// (resolved=#anchor), hidden (hidden=true), draft (draft=true).
export function setQuestionStatus(body, slug, status, resolved) {
  const { lines, blocks } = questionBlocks(body);
  const b = blocks.find((x) => attr(x, 'slug') === slug);
  if (!b) return null;
  const kept = b.attrs.filter(([k]) => !['draft', 'hidden', 'resolved'].includes(k));
  if (status === 'draft') kept.push(['draft', 'true']);
  else if (status === 'hidden') kept.push(['hidden', 'true']);
  else if (status === 'resolved') kept.push(['resolved', resolved]);
  const line = lines[b.start];
  lines[b.start] = line.replace(/\{[\s\S]*\}\s*$/, `{${kept.map(([k, v]) => `${k}=${quote(v)}`).join(' ')}}`);
  return lines.join('\n');
}

// --- the tree, the compile, the version ------------------------------------

export async function readRows(env) {
  const { results } = await env.DB.prepare('SELECT path, status, body, revision, updated_at, updated_by FROM content_items ORDER BY path').all();
  return results || [];
}

// rows -> the files the compiler reads, the drafts it does not, and statuses.
export function materialize(rows, config) {
  const files = { 'site.config.yml': config };
  const drafts = [];
  const statuses = {};
  for (const r of rows) {
    if (r.path === LOCK) { files[LOCK] = r.body; continue; }
    if (r.status === 'draft') { drafts.push({ path: r.path, status: 'draft', body: r.body }); continue; }
    const s = stripDrafts(r.body);
    files[r.path] = s.body;
    for (const q of s.drafts) drafts.push({ path: r.path, status: 'draft-question', slug: q.slug, body: q.text });
    if (r.status !== 'published') statuses[slugOf(r.path)] = r.status;
  }
  return { files, drafts, statuses };
}

export async function build(rows, config) {
  const { files, drafts, statuses } = materialize(rows, config);
  const r = compileFiles({ files });
  if (!r.ok) return { ok: false, errors: r.errors };
  const sources = Object.fromEntries(r.manifest.docs.map((d) => [d.slug, files[d.source === 'README.md' ? 'README.md' : `content/${d.source}`]]));
  const digest = await digestOf(r.manifest, r.fragments, sources);
  return { ok: true, files, drafts, statuses, digest, lockText: r.lockText,
    payload: { manifest: r.manifest, fragments: r.fragments, sections: r.sections, sources, statuses, lockText: r.lockText } };
}

// Apply `changes` ({path, body, status}) to the rows, compile, and write
// everything in one batch. Returns { ok, version, digest } or { ok:false, status, errors }.
export async function commit(env, me, changes, reason) {
  const rows = await readRows(env);
  const byPath = new Map(rows.map((r) => [r.path, { ...r }]));
  for (const c of changes) {
    const prev = byPath.get(c.path);
    byPath.set(c.path, { path: c.path, status: c.status ?? prev?.status ?? 'published', body: c.body ?? prev?.body ?? '',
      revision: (prev?.revision || 0) + 1, prev });
  }
  const next = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const b = await build(next, configText(env));
  if (!b.ok) return { ok: false, status: 422, errors: b.errors };

  // The lock moves when the compile mints or retires a number: that is a
  // content change, and it lands with the save that caused it.
  const lockRow = byPath.get(LOCK);
  if (!lockRow || lockRow.body !== b.lockText) {
    byPath.set(LOCK, { path: LOCK, status: 'published', body: b.lockText, revision: (lockRow?.revision || 0) + 1, prev: lockRow });
    changes = [...changes.filter((c) => c.path !== LOCK), { path: LOCK }];
  }

  const payload = JSON.stringify(b.payload);
  if (payload.length > MAX_PAYLOAD) {
    return { ok: false, status: 413, errors: [`This version would be ${payload.length} bytes; one version must stay under ${MAX_PAYLOAD} (D1's row limit). Split a large document or move data out of the prose.`] };
  }

  const at = now();
  const head = await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM site_versions').first();
  const id = Number(head?.n || 0) + 1;
  const stmts = [];
  for (const c of changes) {
    const r = byPath.get(c.path);
    stmts.push(env.DB.prepare(`INSERT INTO content_items (path, status, body, revision, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET status = excluded.status, body = excluded.body, revision = excluded.revision,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(r.path, r.status, r.body, r.revision, at, me.sub));
    stmts.push(env.DB.prepare('INSERT INTO content_revisions (path, revision, status, body, saved_at, saved_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(r.path, r.revision, r.status, r.body, at, me.sub, c.note || reason || null));
  }
  stmts.push(env.DB.prepare('INSERT INTO site_versions (id, digest, created_at, created_by, created_by_name, reason, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, b.digest, at, me.sub, me.name || me.sub, reason || null, payload));
  stmts.push(...movePointer(env, id, me, reason, at));
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    // A collision on a revision or a version id: somebody saved first.
    return { ok: false, status: 409, errors: [`Somebody else saved at the same moment, so nothing was written. Reload and try again. (${e.message})`] };
  }
  return { ok: true, version: id, digest: b.digest };
}

function movePointer(env, id, me, reason, at = now()) {
  return [
    env.DB.prepare(`INSERT INTO site_live (id, version_id, moved_at, moved_by) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version_id = excluded.version_id, moved_at = excluded.moved_at, moved_by = excluded.moved_by`).bind(id, at, me.sub),
    env.DB.prepare('INSERT INTO site_live_log (at, version_id, moved_by, reason) VALUES (?, ?, ?, ?)').bind(at, id, me.sub, reason || null),
  ];
}

// --- export ------------------------------------------------------------------
// What the nightly Action writes to git: the tree the compiler builds from
// (with site.config.yml, so it compiles on its own), `statuses.json` (the items
// that are members-only or archived) and `drafts.json` (what the site does not
// carry). Plus the digests it must reproduce.
export async function exportBundle(env) {
  const rows = await readRows(env);
  const b = rows.length ? await build(rows, configText(env)) : null;
  const live = await liveId(env);
  const lv = await readVersion(env, live);
  const head = await env.DB.prepare('SELECT id, digest FROM site_versions ORDER BY id DESC LIMIT 1').first();
  if (!b?.ok) return { ok: false, errors: b ? b.errors : ['There are no content rows. Import first.'] };
  const statuses = Object.fromEntries(rows.filter((r) => r.path !== LOCK && !['published', 'draft'].includes(r.status)).map((r) => [r.path, r.status]));
  return {
    ok: true,
    project: (hostOf(env).settings && JSON.parse(JSON.stringify(b.payload.manifest.project))) || {},
    rows_digest: b.digest,
    head: head ? { id: head.id, digest: head.digest } : null,
    live: lv ? { id: lv.id, digest: lv.digest } : null,
    files: b.files,
    statuses,
    drafts: b.drafts,
  };
}

// --- the API -----------------------------------------------------------------

async function bodyOf(request) { try { return await request.json(); } catch { return null; } }

// Constant time, as identity.js compares agent tokens.
async function sameSecret(a, b) {
  const h = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export async function exportAllowed(request, env, me) {
  if (me?.authenticated && me.role === 'admin') return true;
  const presented = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const want = String(env.EXPORT_TOKEN || '').trim();
  return want.length >= 32 && !!presented && await sameSecret(presented, want);
}

export async function handleContent(request, env, me, url) {
  const host = hostOf(env);
  const p = url.pathname;
  const m = request.method.toUpperCase();
  if (host.settings.content.source !== 'rows') return json({ error: 'this site’s content is in git (content.source is not rows)' }, 404);

  // The live version's identity: for the footer, the round trip and the Action.
  if (p === '/api/version' && m === 'GET') {
    const id = await liveId(env);
    const v = id != null ? await readVersion(env, id) : await liveVersion(env, request, host.settings);
    return v ? json({ id: v.id ?? null, digest: v.digest, published_at: v.published_at }) : json({ error: 'no version' }, 404);
  }

  // Read-only, for the nightly Action (EXPORT_TOKEN) or an admin.
  if (p === '/api/content/export' && m === 'GET') {
    if (!(await exportAllowed(request, env, me))) return json({ error: 'not permitted' }, 403);
    const bundle = await exportBundle(env);
    return json(bundle, bundle.ok ? 200 : 409);
  }

  if (!me?.authenticated) return json({ error: 'not signed in' }, 401);
  if (!isEditor(me)) return json({ error: 'editors only (admins and contributors)' }, 403);

  if (p === '/api/content' && m === 'GET') {
    const rows = await readRows(env);
    const live = await liveId(env);
    const lv = await readVersion(env, live);
    const titles = Object.fromEntries((lv?.manifest.docs || []).map((d) => [d.slug, d.title]));
    return json({
      live: lv ? { id: lv.id, digest: lv.digest } : null,
      items: rows.map((r) => ({ path: r.path, slug: slugOf(r.path), title: titles[slugOf(r.path)] || null, status: r.status,
        revision: r.revision, updated_at: r.updated_at, updated_by: r.updated_by, editable: r.path !== LOCK })),
    });
  }

  if (p === '/api/content/item' && m === 'GET') {
    const path = url.searchParams.get('path') || '';
    const row = await env.DB.prepare('SELECT * FROM content_items WHERE path = ?').bind(path).first();
    return row ? json(row) : json({ error: 'no such item' }, 404);
  }

  if (p === '/api/content/item' && m === 'PUT') {
    const b = await bodyOf(request);
    const path = String(b?.path || '');
    if (!validPath(path)) return json({ error: 'path is README.md or content/<name>.md, lowercase' }, 400);
    if (b.status != null && !STATUSES.includes(b.status)) return json({ error: `status is one of ${STATUSES.join(', ')}` }, 400);
    if (path === 'README.md' && b.status && b.status !== 'published') return json({ error: 'About (README.md) is always published' }, 400);
    if (b.body != null && typeof b.body !== 'string') return json({ error: 'body is text' }, 400);
    const row = await env.DB.prepare('SELECT revision FROM content_items WHERE path = ?').bind(path).first();
    // ⚠️ An edit made from an old copy is refused, not merged: the editor
    // reloads and sees what changed under it.
    if ((row?.revision || 0) !== Number(b.base_revision || 0)) {
      return json({ error: `This was revision ${b.base_revision || 0} when you opened it; it is now ${row?.revision || 0}. Reload before saving.` }, 409);
    }
    if (!row && b.body == null) return json({ error: 'a new item needs a body' }, 400);
    const r = await commit(env, me, [{ path, body: b.body ?? undefined, status: b.status ?? undefined, note: b.note }], b.note || `saved ${path}`);
    return r.ok ? json(r) : json({ error: r.errors[0], errors: r.errors }, r.status);
  }

  if (p === '/api/content/question' && m === 'PATCH') {
    const b = await bodyOf(request);
    const status = String(b?.status || '');
    if (!['open', 'resolved', 'hidden', 'draft'].includes(status)) return json({ error: 'status is open, resolved, hidden or draft' }, 400);
    if (status === 'resolved' && !/^\/?[\w/-]*#[\w-]+$/.test(String(b.resolved || ''))) return json({ error: 'resolved needs the anchor that answers it, like #section' }, 400);
    for (const row of await readRows(env)) {
      if (row.path === LOCK) continue;
      const body = setQuestionStatus(row.body, String(b.slug || ''), status, b.resolved);
      if (body == null) continue;
      const r = await commit(env, me, [{ path: row.path, body }], `question ${b.slug}: ${status}`);
      return r.ok ? json(r) : json({ error: r.errors[0], errors: r.errors }, r.status);
    }
    return json({ error: 'no question with that slug' }, 404);
  }

  if (p === '/api/content/preview' && m === 'POST') {
    const b = await bodyOf(request);
    const path = String(b?.path || '');
    if (!validPath(path)) return json({ error: 'bad path' }, 400);
    const rows = (await readRows(env)).filter((r) => r.path !== path);
    // The previewed item is compiled as if published, whatever its status, so
    // a draft can be seen; it is shown with the banner of its status.
    rows.push({ path, status: 'published', body: String(b.body ?? '') });
    const built = await build(rows, configText(env));
    if (!built.ok) return json({ ok: false, errors: built.errors }, 422);
    const view = { id: null, digest: built.digest, published_at: null, ...built.payload };
    const slug = slugOf(path);
    const ctx = ctxFor(env, view);
    const status = b.status && b.status !== 'published' ? b.status : 'draft';
    const html = slug === 'start'
      ? R.layout(ctx, { path: '/about/', title: 'About', body: R.aboutPage(view), status, noindex: true })
      : R.layout(ctx, { path: `/${slug}/`, title: view.manifest.docs.find((d) => d.slug === slug)?.title || slug, body: R.docPage(view, slug), doc: slug, status, noindex: true });
    return json({ ok: true, html, digest: built.digest });
  }

  if (p === '/api/content/revisions' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT revision, status, saved_at, saved_by, note, length(body) AS bytes FROM content_revisions WHERE path = ? ORDER BY revision DESC')
      .bind(url.searchParams.get('path') || '').all();
    return json({ revisions: results || [] });
  }

  if (p === '/api/content/restore' && m === 'POST') {
    const b = await bodyOf(request);
    const rev = await env.DB.prepare('SELECT * FROM content_revisions WHERE path = ? AND revision = ?').bind(String(b?.path || ''), Number(b?.revision)).first();
    if (!rev) return json({ error: 'no such revision' }, 404);
    if (rev.path === LOCK) return json({ error: 'the question lock is never restored: numbers are never reused' }, 400);
    const r = await commit(env, me, [{ path: rev.path, body: rev.body, status: rev.status, note: `restored revision ${rev.revision}` }], `restored ${rev.path} to revision ${rev.revision}`);
    return r.ok ? json(r) : json({ error: r.errors[0], errors: r.errors }, r.status);
  }

  if (p === '/api/versions' && m === 'GET') {
    return json({ versions: await versionsList(env, host.settings, null, 50) });
  }

  if (p === '/api/versions/live' && m === 'POST') {
    const b = await bodyOf(request);
    const v = await readVersion(env, Number(b?.id));
    if (!v) return json({ error: 'no such version' }, 404);
    await env.DB.batch(movePointer(env, v.id, me, b.reason || `made version ${v.id} live`));
    return json({ ok: true, live: v.id, digest: v.digest });
  }

  // From the build this Worker was deployed with, once, into empty rows.
  if (p === '/api/content/import' && m === 'POST') {
    if (me.role !== 'admin') return json({ error: 'admins only' }, 403);
    const any = await env.DB.prepare('SELECT COUNT(*) AS n FROM content_items').first();
    if (any?.n) return json({ error: 'the rows are not empty; import only fills an empty site' }, 409);
    const seed = await liveVersion(env, request, { content: { source: 'git' } });
    if (!seed?.sources) return json({ error: 'the deployed build carries no version to import' }, 409);
    const changes = seed.manifest.docs.map((d) => ({ path: d.source === 'README.md' ? 'README.md' : `content/${d.source}`, body: seed.sources[d.slug], status: 'published' }));
    if (seed.lockText) changes.push({ path: LOCK, body: seed.lockText, status: 'published' });
    const r = await commit(env, me, changes, 'imported from the deployed build');
    return r.ok ? json({ ...r, imported: changes.length }) : json({ error: r.errors[0], errors: r.errors }, r.status);
  }

  return json({ error: 'no such route' }, 404);
}

export { canRead };
