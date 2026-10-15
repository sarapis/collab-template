#!/usr/bin/env node
// The nightly export of a rows site's content to git
// (.github/workflows/content-export.yml; TEMPLATE.md "Content as rows").
//
//   node scripts/content-export.mjs target   print the target (from site.config.yml) for the workflow
//   node scripts/content-export.mjs write --out=DIR [--url=URL]
//        fetch the rows from the live site, write them under DIR/<content.export.path>,
//        and refuse unless the tree written there compiles to the digest the site
//        is serving (the round trip, HOST-CONTRACT.md "Digest").
//
// The site is asked with EXPORT_TOKEN (the Worker's read-only export door); the
// URL is --url or COLLAB_URL. ⚠️ This script never holds a git credential and
// never pushes: the workflow does, with a deploy key on the TARGET repository,
// so the Worker and this script can both be read-only.
//
// What lands under the path: the tree the compiler builds from (site.config.yml,
// README.md, content/**, content/questions.lock), statuses.json (the items that
// are members-only or archived) and drafts.json (what the site does not carry).
// ⚠️ Members-only text is in that tree: the target repository must be private.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { compile } from '../packages/compile/src/index.js';
import { digest, sourcesOf } from '../conformance/digest.mjs';
import { settingsFrom } from '../worker/src/settings.js';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (k) => rest.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const config = yaml.load(fs.readFileSync('site.config.yml', 'utf8')) || {};
const settings = settingsFrom(config);
const die = (msg) => { console.error(`content-export: ${msg}`); process.exit(1); };

// Every file under dir, as paths relative to it.
const walk = (dir, base = '') => fs.existsSync(path.join(dir, base)) ? fs.readdirSync(path.join(dir, base), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(dir, path.posix.join(base, e.name)) : [path.posix.join(base, e.name)])) : [];

export function writeTree(root, bundle) {
  // ⚠️ The folder is REPLACED, so a document deleted on the site is deleted in
  // git too. Only this folder: the export never touches the rest of the repo.
  fs.rmSync(root, { recursive: true, force: true });
  for (const [f, text] of Object.entries(bundle.files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  fs.writeFileSync(path.join(root, 'statuses.json'), JSON.stringify(bundle.statuses, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'drafts.json'), JSON.stringify(bundle.drafts, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'EXPORT.md'), [
    `# ${bundle.project?.name || 'Collaboration site'}: content export`,
    '',
    'GENERATED every night from the live site by its content-export workflow.',
    '⚠️ Do not edit these files here: the site is where they are edited, and the',
    'next export replaces this folder. Nothing reads it back.',
    '',
    'The files are the tree the site compiles (README.md is the About page). An',
    'item\'s status is in statuses.json; drafts the site does not show are in',
    'drafts.json.',
    '',
  ].join('\n'));
}

// The round trip: this tree compiles, with the compiler the CLI runs, to the
// digest the rows compile to and the live site is serving. Returns problems.
export function roundTrip(root, bundle) {
  const r = compile({ root });
  if (!r.ok) return r.errors.map((e) => `the exported tree does not compile: ${e}`);
  const out = [];
  const got = digest(r.manifest, r.fragments, sourcesOf(root, r.manifest));
  if (r.lockText !== bundle.files['content/questions.lock']) out.push('the exported lock is not the one this tree compiles to');
  if (got !== bundle.rows_digest) out.push(`the tree compiles to ${got}; the rows compile to ${bundle.rows_digest}`);
  if (!bundle.live) out.push('the site has no live version from its rows');
  else if (bundle.live.digest !== got) {
    out.push(bundle.head && bundle.head.id !== bundle.live.id
      ? `the live site is version ${bundle.live.id} (${bundle.live.digest.slice(0, 12)}), rolled back from ${bundle.head.id}: the rows and the live site differ until somebody saves or makes the latest live`
      : `the live site serves ${bundle.live.digest}; the tree compiles to ${got}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ex = settings.content.export;
  if (cmd === 'target') {
    // For the workflow: key=value lines it appends to $GITHUB_OUTPUT.
    if (settings.content.source !== 'rows' || !ex) { console.log('enabled=false'); process.exit(0); }
    console.log(['enabled=true', `repo=${ex.repo}`, `path=${ex.path}`, `branch=${ex.branch}`, `push_branch=${ex.push_branch}`,
      `project=${config.project?.id || 'project'}`].join('\n'));
  } else if (cmd === 'write') {
    if (!ex) die('content.export is not set in site.config.yml');
    const url = (opt('url') || process.env.COLLAB_URL || '').replace(/\/+$/, '');
    const token = String(process.env.EXPORT_TOKEN || '').trim();
    if (!url) die('no site URL: pass --url= or set COLLAB_URL');
    if (!token) die('EXPORT_TOKEN is not set');
    const r = await fetch(`${url}/api/content/export`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) die(`${url}/api/content/export answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const bundle = await r.json();
    if (!bundle.ok) die(`the site cannot export: ${(bundle.errors || []).join('; ')}`);
    const root = path.join(opt('out') || '.', ex.path);
    writeTree(root, bundle);
    const problems = roundTrip(root, bundle);
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length) die('the round trip failed; nothing should be committed');
    console.log(`content-export: ${Object.keys(bundle.files).length} files to ${root}, version ${bundle.live.id}, digest ${bundle.live.digest}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${bundle.live.id}\ndigest=${bundle.live.digest}\n`);
  } else {
    console.error('usage: content-export.mjs target | write --out=DIR [--url=URL]');
    process.exit(2);
  }
}
