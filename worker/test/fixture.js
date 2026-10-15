// A band-layout Worker over the sample project, for tests.
//
// The version is compiled here from the repository's own content with the real
// compiler, exactly as scripts/build-worker-data.mjs makes build/version.json,
// so these tests need no build and test what a deploy would serve.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, readProject } from '../../packages/compile/src/index.js';
import { digest, sourcesOf } from '../../conformance/digest.mjs';
import { d1 } from './d1.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// ⚠️ The tests' own project, not the instance's content/ (which a fork replaces).
export const PROJECT = path.join(ROOT, 'worker/test/project');

export function sampleVersion(root = PROJECT) {
  const r = compile({ root });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  const sources = sourcesOf(root, r.manifest);
  return {
    id: null, digest: digest(r.manifest, r.fragments, sources), published_at: '2026-10-14T12:00:00.000Z',
    published_by: null, commit: 'abc1234def', manifest: r.manifest, fragments: r.fragments, sections: r.sections,
    sources, statuses: {}, lockText: r.lockText,
  };
}

export const sampleFiles = (root = PROJECT) => readProject({ root });

export function host({ layout = 'band', source = 'git', tools, groups } = {}) {
  return {
    settings: { layout, content: { source, export: null } },
    nav_artifacts: [], chat: { enabled: false, retention_days: 90 },
    public: { repo: null, contact: 'the team', llms_txt: true },
  };
}

// ⚠️ A binding the way the Workers runtime hands one over, not a plain object.
// `env.ASSETS` is an RPC stub: asking it for ANY property it does not have
// returns another stub (truthy), and calling that throws "The RPC receiver
// does not implement the method". Code that probed a binding for a marker of
// its own (`env.ASSETS?.real`) passed every test against a plain object and
// threw on every signed-in page in production (v1.2.0, ctfg-collab, 2026-10-15).
export function rpcBinding(fetch) {
  const stub = (name) => {
    const fail = () => { throw new TypeError(`The RPC receiver does not implement the method "${name}".`); };
    return new Proxy(fail, { get: (_, p) => (p === 'then' ? undefined : stub(`${name}.${String(p)}`)) });
  };
  return new Proxy({ fetch }, { get: (t, p) => (p in t ? t[p] : p === 'then' ? undefined : stub(String(p))) });
}

// An ASSETS binding: the version at /_build/version.json, and any `pages`.
export function assets(version, pages = {}) {
  return rpcBinding(async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/_build/version.json') return new Response(JSON.stringify(version), { headers: { 'content-type': 'application/json' } });
    if (pages[p] != null) return new Response(pages[p], { headers: { 'content-type': p.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' } });
    return new Response('Not found', { status: 404 });
  });
}

export function plainAssets(version, pages = {}) {
  return {
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === '/_build/version.json') return new Response(JSON.stringify(version), { headers: { 'content-type': 'application/json' } });
      if (pages[p] != null) return new Response(pages[p], { headers: { 'content-type': p.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' } });
      return new Response('Not found', { status: 404 });
    },
  };
}

export const ADMIN = 'admin@example.org';
export const EDITOR = 'editor@example.org';
export const READER = 'reader@example.org';

export async function seedPeople(db) {
  const at = '2026-10-01T00:00:00Z';
  for (const [email, role, aud] of [[ADMIN, 'admin', '["team"]'], [EDITOR, 'contributor', '["team"]'], [READER, 'user', '["reviewers"]']]) {
    await db.prepare('INSERT INTO users (email, name, role, audiences, created_at) VALUES (?, ?, ?, ?, ?)').bind(email, email.split('@')[0], role, aud, at).run();
  }
}

export async function bandEnv({ version = sampleVersion(), publicRead = false, source = 'git', pages = {}, db } = {}) {
  db = db || d1();
  await seedPeople(db);
  const files = sampleFiles();
  return {
    DB: db, ASSETS: assets(version, pages), AGENT_TOKENS: '{}', PUBLIC_READ: publicRead ? 'true' : 'false', DEV_SIGN_IN: 'true',
    COLLAB_HOST: host({ source }), COLLAB_CONFIG_TEXT: files['site.config.yml'],
  };
}

export const get = (p, who, init = {}) => new Request('https://collab.test' + p, {
  ...init, headers: { ...(who ? { cookie: `collab_session=${who}` } : {}), ...(init.headers || {}) } });

export const send = (method, p, who, body, headers = {}) => get(p, who, {
  method, body: body == null ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

export const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
