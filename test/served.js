// The pages a band-layout site actually serves (`site.layout: band`).
//
// ⚠️ In the band layout the files in _site are not the pages: the Worker
// renders the content's pages per viewer and wraps the rest. Checking the files
// would check something no reader is ever sent, so the gate asks the Worker,
// over the built _site, signed in as an admin (who is shown the most), for
// every page, and checks those.
import fs from 'node:fs';
import path from 'node:path';
import worker from '../worker/src/index.js';
import { HOST } from '../worker/src/site.generated.js';
import { d1 } from '../worker/test/d1.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

function files(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) out.push(...files(dir, rel));
    else out.push(rel);
  }
  return out;
}

export async function servedPages(site = '_site') {
  const assets = {
    async fetch(req) {
      let p = decodeURIComponent(new URL(req.url).pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(site, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(f), { headers: { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' } });
    },
  };
  const DB = d1();
  await DB.prepare("INSERT INTO users (email, name, role, audiences, created_at) VALUES ('gate@example.org', 'Gate', 'admin', '[]', '2026-01-01')").run();
  const env = { DB, ASSETS: assets, AGENT_TOKENS: '{}', PUBLIC_READ: 'false', DEV_SIGN_IN: 'true', COLLAB_HOST: HOST };
  const version = JSON.parse(fs.readFileSync(path.join(site, '_build/version.json'), 'utf8'));
  const urls = new Set(['/', '/about/', '/get-involved/', '/questions/', '/activity/']);
  for (const d of version.manifest.docs) if (!d.partial && d.slug !== 'start') urls.add(`/${d.slug}/`);
  for (const f of files(site)) if (f.endsWith('.html')) urls.add('/' + f.replace(/index\.html$/, ''));
  const out = [];
  for (const u of urls) {
    const r = await worker.fetch(new Request('https://gate.test' + u, { headers: { cookie: 'collab_session=gate@example.org' } }), env);
    if (r.status !== 200) throw new Error(`the band site answers ${u} with ${r.status}`);
    out.push({ path: u === '/' ? '/index.html' : `${u}index.html`, html: await r.text() });
  }
  return out;
}
