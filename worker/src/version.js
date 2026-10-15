// The live version: what a reader is shown, and what a viewer may see of it.
//
// A VERSION is one compiled state of the project (HOST-CONTRACT.md, Part 1):
//   { id, digest, published_at, published_by, commit,
//     manifest, fragments, sections, sources, statuses }
// `statuses` maps a document slug to `published`, `members` or `archived`. A
// draft is never compiled, so it is never in a version.
//
// Where the live version comes from is a setting (`content.source`):
//   git   the build: scripts/build-worker-data.mjs writes build/version.json and
//         Eleventy copies it to /_build/version.json, which the Worker reads and
//         never serves.
//   rows  D1: `site_versions`, with `site_live` pointing at the one that is live.
//
// ⚠️ forViewer() is the ONE place a members-only item is taken out of what a
// non-member is shown: the documents, their questions, their sections, their
// sources, the quotes and figures in them, and the counts. Pages, /api/, MCP and
// the assistant all read through it (index.js `viewAssets`), so a door added
// later cannot read around it. The decision for one item is canRead().
import { canRead } from './identity.js';

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v);

// HOST-CONTRACT.md "Digest": byte-for-byte conformance/digest.mjs, in WebCrypto
// so the Worker can compute it. worker/test/version.test.js holds the two equal.
export function canonical(manifest, fragments, sources) {
  return JSON.stringify(sortKeys({ manifest, fragments, sources }));
}

export async function digestOf(manifest, fragments, sources) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(manifest, fragments, sources)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ⚠️ The viewer's wrappers, each mapped to the real binding it wraps. Kept HERE,
// never as a property on the binding or the wrapper: in the Workers runtime
// `env.ASSETS` is an RPC stub, and asking it for any property it does not have
// returns a truthy stub that throws when used. Probing it for a marker
// (`env.ASSETS?.real`, v1.2.0) threw on every signed-in page in production.
const wrapped = new WeakMap();
export const realAssets = (assets) => wrapped.get(assets) || assets;
export const markWrapped = (view, real) => { wrapped.set(view, real); };
export const isWrapped = (assets) => wrapped.has(assets);

// Per isolate. A version never changes once written, so caching by id is safe;
// only the pointer is read on every request. The build's version is cached per
// assets binding (one deploy, one build).
const cache = new Map();
const dbIds = new WeakMap();
let dbSeq = 0;
const dbKey = (db) => { if (!dbIds.has(db)) dbIds.set(db, ++dbSeq); return dbIds.get(db); };
const builds = new WeakMap();

async function fromBuild(env, request) {
  // The real binding, also when a handler holds the viewer's (band.js viewEnv).
  const assets = realAssets(env.ASSETS);
  if (!assets) return null;
  if (builds.has(assets)) return builds.get(assets);
  const r = await assets.fetch(new Request(new URL('/_build/version.json', request.url)));
  if (!r.ok) return null;
  const v = await r.json();
  builds.set(assets, v);
  return v;
}

export async function liveId(env) {
  const row = await env.DB.prepare('SELECT version_id FROM site_live WHERE id = 1').first().catch(() => null);
  return row?.version_id ?? null;
}

export async function readVersion(env, id) {
  if (id == null) return null;
  // Keyed by database as well: two D1 bindings (tests; never production) must
  // not share a version 1.
  const key = `${dbKey(env.DB)}:${id}`;
  if (cache.has(key)) return cache.get(key);
  const row = await env.DB.prepare('SELECT * FROM site_versions WHERE id = ?').bind(id).first();
  if (!row) return null;
  const v = { id: row.id, digest: row.digest, published_at: row.created_at, published_by: row.created_by_name,
    reason: row.reason, commit: null, ...JSON.parse(row.payload) };
  cache.set(key, v);
  return v;
}

export async function liveVersion(env, request, settings) {
  if (settings?.content?.source === 'rows') {
    // ⚠️ Rows mode with no version yet (nothing imported) falls back to the
    // build, so a freshly deployed site shows its seed content rather than
    // nothing. The first import or save replaces it.
    const id = await liveId(env);
    return (id != null && await readVersion(env, id)) || fromBuild(env, request);
  }
  return fromBuild(env, request);
}

export function statusOf(version, slug) {
  return version?.statuses?.[slug] || 'published';
}

// Recompute what the compiler counts, from what the viewer kept
// (HOST-CONTRACT.md: a host that filters questions recomputes the counts).
export function countsOf(docs, questions) {
  return {
    documents: docs.length,
    questions: questions.length,
    visible: questions.filter((q) => !q.hidden).length,
    resolved: questions.filter((q) => q.resolved).length,
    open: questions.filter((q) => !q.resolved && !q.hidden).length,
  };
}

// The version as this viewer may see it.
export function forViewer(version, env, me) {
  if (!version) return null;
  const keep = (slug) => canRead(env, me, { status: statusOf(version, slug) });
  const m = version.manifest;
  if (m.docs.every((d) => keep(d.slug))) return version;

  const docs = m.docs.filter((d) => keep(d.slug));
  const slugs = new Set(docs.map((d) => d.slug));
  const questions = m.questions.filter((q) => slugs.has(q.doc))
    // A question in a kept document may still cite a passage in a dropped one;
    // the reference goes, so the dropped document's heading is not shown either.
    .map((q) => ({ ...q, see: (q.see || []).filter((r) => r.kind !== 'section' || slugs.has(r.doc)) }));
  const only = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => slugs.has(k.split('#')[0])));
  return {
    ...version,
    manifest: {
      ...m,
      docs,
      questions,
      quotes: (m.quotes || []).filter((x) => slugs.has(x.doc)),
      figures: (m.figures || []).filter((x) => slugs.has(x.doc)),
      counts: countsOf(docs, questions),
    },
    fragments: only(version.fragments),
    sections: only(version.sections),
    sources: only(version.sources),
    statuses: only(version.statuses),
    filtered: true,
  };
}

// The markdown source a doc's `source` path names, from a version.
export function sourceByPath(version, rel) {
  const doc = version.manifest.docs.find((d) => d.source === rel);
  return doc ? version.sources?.[doc.slug] ?? null : null;
}
