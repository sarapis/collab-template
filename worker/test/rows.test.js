// Content as rows (`content.source: rows`; worker/src/content.js), against real
// SQLite with worker/schema.sql, through the Worker's own front door.
//
// ⚠️ The round trip at the end is the measure Databook set (decision 37): the
// rows, the tree a nightly export writes to git, and the live site carry ONE
// digest, and it is HOST-CONTRACT.md's, so it is the same number Python gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../src/index.js';
import { compile } from '../../packages/compile/src/index.js';
import { digest, sourcesOf } from '../../conformance/digest.mjs';
import { stripDrafts, setQuestionStatus } from '../src/content.js';
import { bandEnv, sampleVersion, get, send, ADMIN, EDITOR, READER } from './fixture.js';

const go = (env, req) => worker.fetch(req, env);
const body = async (env, req) => { const r = await go(env, req); return { r, j: await r.json().catch(() => null) }; };
const count = async (env, table) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const item = async (env, p) => (await body(env, get(`/api/content/item?path=${encodeURIComponent(p)}`, EDITOR))).j;
const save = (env, p, changes, who = EDITOR) => item(env, p).then((it) => body(env, send('PUT', '/api/content/item', who,
  { path: p, base_revision: it?.revision || 0, ...changes })));
const page = async (env, p, who = ADMIN) => (await go(env, get(p, who))).text();
const TOKEN = 'export-token-for-tests-0123456789abcdef';

async function rowsSite(opts = {}) {
  const version = sampleVersion();
  const env = await bandEnv({ version, source: 'rows', ...opts });
  env.EXPORT_TOKEN = TOKEN;
  const imp = await body(env, send('POST', '/api/content/import', ADMIN));
  assert.equal(imp.r.status, 200, JSON.stringify(imp.j));
  return { env, version, imported: imp.j };
}

test('import fills empty rows from the deployed build, and the digest does not move', async () => {
  const { env, version, imported } = await rowsSite();
  assert.equal(imported.version, 1);
  assert.equal(imported.digest, version.digest, 'rows compiled = the build that seeded them');
  assert.equal(await count(env, 'content_items'), version.manifest.docs.length + 1, 'every document, plus the lock');
  const again = await body(env, send('POST', '/api/content/import', ADMIN));
  assert.equal(again.r.status, 409, 'import never overwrites rows');
});

test('a save rebuilds the site and moves the live pointer in one step', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  const s = await save(env, 'content/plan.md', { body: it.body.replace('A short document', 'A SAVED document') });
  assert.equal(s.r.status, 200, JSON.stringify(s.j));
  assert.equal(s.j.version, 2);
  assert.match(await page(env, '/plan/'), /A SAVED document/);
  assert.match(await page(env, '/plan/'), new RegExp(`data-digest="${s.j.digest}"`));
  const live = (await body(env, get('/api/version', READER))).j;
  assert.deepEqual([live.id, live.digest], [2, s.j.digest]);
});

test('a save that does not compile writes NOTHING and says why', async () => {
  const { env } = await rowsSite();
  const before = { items: await count(env, 'content_items'), revs: await count(env, 'content_revisions'), versions: await count(env, 'site_versions'), plan: (await item(env, 'content/plan.md')).body };
  const it = await item(env, 'content/plan.md');
  const s = await save(env, 'content/plan.md', { body: it.body.replace('audience=team', 'audience=nobody-declared') });
  assert.equal(s.r.status, 422);
  assert.match(s.j.error, /nobody-declared/);
  assert.deepEqual({ items: await count(env, 'content_items'), revs: await count(env, 'content_revisions'), versions: await count(env, 'site_versions'), plan: (await item(env, 'content/plan.md')).body }, before);
  assert.equal((await body(env, get('/api/version', READER))).j.id, 1, 'the live site did not move');
});

test('an edit made from an old copy is refused, not merged', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  await save(env, 'content/plan.md', { body: it.body + '\nFirst.\n' });
  const stale = await body(env, send('PUT', '/api/content/item', EDITOR, { path: 'content/plan.md', base_revision: it.revision, body: it.body + '\nSecond.\n' }));
  assert.equal(stale.r.status, 409);
});

test('two saves racing for one version: the batch fails whole and nothing half-lands', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  // Somebody else's save takes version 2 after this save read the rows and
  // before its batch runs.
  const batch = env.DB.batch;
  env.DB.batch = async (stmts) => {
    env.DB.batch = batch;
    await env.DB.prepare("INSERT INTO site_versions (id, digest, created_at, created_by, payload) VALUES (2, 'x', 'now', 'other', '{}')").run();
    return batch(stmts);
  };
  const before = await count(env, 'content_revisions');
  const s = await save(env, 'content/plan.md', { body: it.body + '\nRacing.\n' });
  assert.equal(s.r.status, 409);
  assert.equal(await count(env, 'content_revisions'), before, 'no revision row survived the failed batch');
  assert.equal((await item(env, 'content/plan.md')).body, it.body, 'the row is unchanged');
});

test('a reader cannot edit; an editor is an admin or a contributor', async () => {
  const { env } = await rowsSite();
  const r = await go(env, send('PUT', '/api/content/item', READER, { path: 'content/plan.md', base_revision: 1, body: 'x' }));
  assert.equal(r.status, 403);
  assert.equal((await go(env, get('/api/content', READER))).status, 403);
  assert.equal((await go(env, get('/api/content', null))).status, 401);
});

test('a draft document is never compiled, and a new one appears when published', async () => {
  const { env } = await rowsSite();
  const s = await save(env, 'content/notes.md', { status: 'draft', body: '---\ntitle: Working notes\n---\n\n# Working notes\n\nDRAFT-TEXT\n' });
  assert.equal(s.r.status, 200, JSON.stringify(s.j));
  assert.equal((await go(env, get('/notes/', ADMIN))).status, 404, 'not even an admin is served a draft as a page');
  assert.doesNotMatch(await page(env, '/'), /Working notes/);
  const pub = await save(env, 'content/notes.md', { status: 'published' });
  assert.equal(pub.r.status, 200);
  assert.match(await page(env, '/notes/'), /DRAFT-TEXT/);
  assert.match(await page(env, '/'), /Working notes/);
});

test('a draft question is cut from the compiled document and kept for the export', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  const draft = '\n## Later {#later}\n\n:::question{slug=draft-one audience=team group=scope asked=r1 draft=true}\nDRAFT-QUESTION?\n:::\n';
  assert.equal((await save(env, 'content/plan.md', { body: it.body + draft })).r.status, 200);
  assert.doesNotMatch(await page(env, '/questions/'), /DRAFT-QUESTION/);
  assert.doesNotMatch(await page(env, '/plan/'), /DRAFT-QUESTION/);
  const ex = (await body(env, get('/api/content/export', ADMIN))).j;
  assert.ok(ex.drafts.some((x) => x.slug === 'draft-one' && x.body.includes('DRAFT-QUESTION')));
  assert.ok(!ex.files['content/plan.md'].includes('DRAFT-QUESTION'));
});

test('a question’s status is set as a field and written back as its attributes', async () => {
  const { env } = await rowsSite();
  const r = await body(env, send('PATCH', '/api/content/question', EDITOR, { slug: 'first-audience', status: 'resolved', resolved: '#making' }));
  assert.equal(r.r.status, 200, JSON.stringify(r.j));
  const m = await (await go(env, get('/manifest.json', ADMIN))).json();
  assert.equal(m.questions.find((q) => q.slug === 'first-audience').resolved, '#making');
  assert.match((await item(env, 'content/plan.md')).body, /:::question\{slug=first-audience audience=team group=scope asked=r1 resolved=#making\}/);
  const bad = await body(env, send('PATCH', '/api/content/question', EDITOR, { slug: 'first-audience', status: 'resolved', resolved: '#no-such-anchor' }));
  assert.equal(bad.r.status, 422, 'resolving against an anchor nothing declares does not compile');
});

test('a new question gets the next number, and the lock lands with the save', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  const add = '\n## Next {#next}\n\n:::question{slug=third-one audience=team group=scope asked=r1}\nA third?\n:::\n';
  assert.equal((await save(env, 'content/plan.md', { body: it.body + add })).r.status, 200);
  const lock = JSON.parse((await item(env, 'content/questions.lock')).body);
  assert.equal(lock.numbers['third-one'], 3);
  const now = await item(env, 'content/plan.md');
  assert.equal((await save(env, 'content/plan.md', { body: now.body.replace(add, '') })).r.status, 200);
  const after = JSON.parse((await item(env, 'content/questions.lock')).body);
  assert.equal(after.retired['third-one'], 3, 'a removed question keeps its number, retired');
  const lockEdit = await save(env, 'content/questions.lock', { body: '{}' });
  assert.equal(lockEdit.r.status, 400, 'the lock is never edited by hand');
});

test('members-only set from the editor: a stranger on a public site gets a 404', async () => {
  const { env } = await rowsSite({ publicRead: true });
  assert.equal((await save(env, 'content/plan.md', { status: 'members' })).r.status, 200);
  assert.equal((await go(env, get('/plan/', null))).status, 404);
  assert.match(await page(env, '/plan/', READER), /status-banner members/);
});

test('revisions are kept, and restoring one is a save like any other', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  await save(env, 'content/plan.md', { body: it.body.replace('A short document', 'REWRITTEN') });
  const revs = (await body(env, get('/api/content/revisions?path=content/plan.md', EDITOR))).j.revisions;
  assert.deepEqual(revs.map((r) => r.revision), [2, 1]);
  const r = await body(env, send('POST', '/api/content/restore', EDITOR, { path: 'content/plan.md', revision: 1 }));
  assert.equal(r.r.status, 200);
  assert.equal((await item(env, 'content/plan.md')).body, it.body);
  assert.equal(r.j.digest, (await body(env, get('/api/version', READER))).j.digest);
});

test('rollback moves the live pointer back, and forward again', async () => {
  const { env, version } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  const s = await save(env, 'content/plan.md', { body: it.body.replace('A short document', 'NEWER') });
  const back = await body(env, send('POST', '/api/versions/live', EDITOR, { id: 1 }));
  assert.equal(back.r.status, 200);
  assert.doesNotMatch(await page(env, '/plan/'), /NEWER/);
  assert.match(await page(env, '/plan/'), new RegExp(`data-digest="${version.digest}"`));
  await body(env, send('POST', '/api/versions/live', EDITOR, { id: s.j.version }));
  assert.match(await page(env, '/plan/'), /NEWER/);
  const log = await env.DB.prepare('SELECT version_id FROM site_live_log ORDER BY rowid').all();
  assert.deepEqual(log.results.map((x) => x.version_id), [1, 2, 1, 2]);
});

test('preview shows an unsaved edit under a Draft banner and writes nothing', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  const before = await count(env, 'site_versions');
  const p = await body(env, send('POST', '/api/content/preview', EDITOR, { path: 'content/plan.md', body: it.body.replace('A short document', 'PREVIEWED') }));
  assert.equal(p.r.status, 200);
  assert.match(p.j.html, /PREVIEWED/);
  assert.match(p.j.html, /status-banner draft/);
  assert.equal(await count(env, 'site_versions'), before);
  assert.doesNotMatch(await page(env, '/plan/'), /PREVIEWED/);
});

test('a version too large for one D1 row is refused with a sentence', async () => {
  const { env } = await rowsSite();
  const s = await save(env, 'content/huge.md', { body: '# Huge\n\n' + 'x'.repeat(1_000_000) + '\n' });
  assert.equal(s.r.status, 413);
  assert.match(s.j.error, /row limit/);
});

test('export: only its token or an admin; a stranger meets the read gate', async () => {
  const { env } = await rowsSite();
  assert.equal((await go(env, get('/api/content/export', null))).status, 401);
  assert.equal((await go(env, get('/api/content/export', null, { headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token' } }))).status, 403);
  assert.equal((await go(env, get('/api/content/export', EDITOR))).status, 403, 'an editor is not the export');
  assert.equal((await go(env, get('/api/content/export', null, { headers: { authorization: `Bearer ${TOKEN}` } }))).status, 200);
  const short = { ...env, EXPORT_TOKEN: 'short' };
  assert.equal((await go(short, get('/api/content/export', null, { headers: { authorization: 'Bearer short' } }))).status, 403, 'a weak token turns the door off');
});

test('THE ROUND TRIP: rows, the git export and the live site carry one digest', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  await save(env, 'content/plan.md', { body: it.body.replace('A short document', 'ROUND-TRIP document') });
  await save(env, 'content/plan.md', { status: 'members' });
  const ex = (await body(env, get('/api/content/export', null, { headers: { authorization: `Bearer ${TOKEN}` } }))).j;
  // What the Action does: write the tree, compile it with the CLI's compiler,
  // and digest it the way HOST-CONTRACT.md says.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-export-'));
  try {
    for (const [f, text] of Object.entries(ex.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
    const r = compile({ root: dir });
    assert.deepEqual(r.errors, []);
    assert.equal(r.lockText, ex.files['content/questions.lock'], 'the exported lock is the one this tree compiles to');
    const git = digest(r.manifest, r.fragments, sourcesOf(dir, r.manifest));
    const live = (await body(env, get('/api/version', ADMIN))).j.digest;
    const footer = (await page(env, '/')).match(/data-digest="([0-9a-f]{64})"/)[1];
    assert.deepEqual({ rows: ex.rows_digest, head: ex.head.digest, live: ex.live.digest, api: live, footer }, { rows: git, head: git, live: git, api: git, footer: git });
    assert.deepEqual(ex.statuses, { 'content/plan.md': 'members' }, 'members-only travels as a status, not lost');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the round trip can see a tree that has drifted from the rows', async () => {
  const { env } = await rowsSite();
  const ex = (await body(env, get('/api/content/export', ADMIN))).j;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-export-'));
  try {
    for (const [f, text] of Object.entries(ex.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), f === 'content/plan.md' ? text + '\nedited in git\n' : text);
    }
    const r = compile({ root: dir });
    assert.notEqual(digest(r.manifest, r.fragments, sourcesOf(dir, r.manifest)), ex.live.digest);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('draft questions are found the way the compiler finds blocks', () => {
  const src = 'x\n\n:::question{slug=a audience=t asked=r1 draft=true}\nQ?\n:::\n\ny\n\n::::question{slug=b audience=t asked=r1}\nP?\n::::\n';
  const s = stripDrafts(src);
  assert.deepEqual(s.drafts.map((d) => d.slug), ['a']);
  assert.ok(!s.body.includes('Q?') && s.body.includes('P?'));
  assert.equal(setQuestionStatus(src, 'b', 'hidden'), src.replace('asked=r1}\nP?', 'asked=r1 hidden=true}\nP?'));
  assert.equal(setQuestionStatus(src, 'nope', 'hidden'), null);
});

test('rows mode with no version yet shows the build it was deployed with', async () => {
  const version = sampleVersion();
  const env = await bandEnv({ version, source: 'rows' });
  assert.match(await page(env, '/'), new RegExp(`data-digest="${version.digest}"`));
});

test('the export script writes the tree and passes its own round trip; a rollback is named, not passed', async () => {
  const { writeTree, roundTrip } = await import('../../scripts/content-export.mjs');
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  await save(env, 'content/plan.md', { body: it.body.replace('A short document', 'EXPORTED document') });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-export-'));
  try {
    const bundle = (await body(env, get('/api/content/export', ADMIN))).j;
    fs.mkdirSync(path.join(dir, 'docs/collab/stale'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/collab/stale/old.md'), 'deleted on the site');
    writeTree(path.join(dir, 'docs/collab'), bundle);
    assert.ok(!fs.existsSync(path.join(dir, 'docs/collab/stale/old.md')), 'a document deleted on the site is deleted in git');
    assert.ok(fs.existsSync(path.join(dir, 'docs/collab/statuses.json')) && fs.existsSync(path.join(dir, 'docs/collab/drafts.json')));
    assert.deepEqual(roundTrip(path.join(dir, 'docs/collab'), bundle), []);

    await body(env, send('POST', '/api/versions/live', EDITOR, { id: 1 }));
    const rolled = (await body(env, get('/api/content/export', ADMIN))).j;
    writeTree(path.join(dir, 'docs/collab'), rolled);
    const problems = roundTrip(path.join(dir, 'docs/collab'), rolled);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /rolled back from 2/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pull mode: the target runs the export itself, and only the target the site names', async () => {
  const { pullTarget, writeTree, roundTrip } = await import('../../scripts/content-export.mjs');
  const { env } = await rowsSite();
  const config = (pull) => `${env.COLLAB_CONFIG_TEXT}\nsite:\n  layout: band\ncontent:\n  source: rows\n  export:\n    repo: Example/Target\n    path: docs/collab\n${pull ? '    mode: pull\n' : ''}`;
  const bundle = (await body(env, get('/api/content/export', ADMIN))).j;
  const as = (pull) => ({ ...bundle, files: { ...bundle.files, 'site.config.yml': config(pull) } });

  const ok = pullTarget(as(true), 'example/target');
  assert.equal(ok.error, undefined);
  assert.equal(ok.export.path, 'docs/collab');
  assert.match(pullTarget(as(true), 'example/other').error, /exports to Example\/Target, and this is example\/other/);
  assert.match(pullTarget(as(true), undefined).error, /GITHUB_REPOSITORY/);
  assert.match(pullTarget(as(false), 'example/target').error, /not pull/, 'a push-mode site is not pulled');

  // The tree a target writes passes the same round trip.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-pull-'));
  try {
    writeTree(path.join(dir, ok.export.path), as(true));
    assert.deepEqual(roundTrip(path.join(dir, ok.export.path), as(true)), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pull mode: the instance’s own export workflow stands down; push mode still runs', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = path.resolve('scripts/content-export.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-target-'));
  const target = (mode) => {
    fs.writeFileSync(path.join(dir, 'site.config.yml'), `project: { id: x }\nsite: { layout: band }\ncontent:\n  source: rows\n  export: { repo: o/r, path: docs/collab${mode ? `, mode: ${mode}` : ''} }\n`);
    return execFileSync(process.execPath, [script, 'target'], { cwd: dir, encoding: 'utf8' });
  };
  try {
    assert.equal(target('pull').trim(), 'enabled=false');
    assert.match(target(null), /^enabled=true\nrepo=o\/r\npath=docs\/collab/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- batch saves and moves (POST /api/content/batch) -----------------------

const batch = (env, b, who = EDITOR) => body(env, send('POST', '/api/content/batch', who, b));
const numbers = (v) => Object.fromEntries(v.manifest.questions.map((q) => [q.slug, [q.number, q.id]]));
const liveView = async (env) => {
  const id = (await body(env, get('/api/version', ADMIN))).j.id;
  return JSON.parse((await env.DB.prepare('SELECT payload FROM site_versions WHERE id = ?').bind(id).first()).payload);
};

test('a move cannot be two item saves: the copy and the original share question slugs', async () => {
  // The reason the batch route exists. Either half alone fails to compile.
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  const copy = await body(env, send('PUT', '/api/content/item', EDITOR, { path: 'content/guides/plan.md', base_revision: 0, body: it.body }));
  assert.equal(copy.r.status, 422, JSON.stringify(copy.j));
});

test('a batch moves a document: numbers, answers and comments follow it, history stays', async () => {
  const { env } = await rowsSite();
  const before = numbers(await liveView(env));
  const it = await item(env, 'content/plan.md');
  await env.DB.prepare("INSERT INTO comments (id, thread, doc, section, author_sub, author_name, body, created_at) VALUES ('c1', 'general', 'plan', 'measure', 'x', 'X', 'on the plan', 'now')").run();

  const r = await batch(env, { moves: [{ from: 'content/plan.md', to: 'content/guides/plan.md', base_revision: it.revision }] });
  assert.equal(r.r.status, 200, JSON.stringify(r.j));

  // Question ids are project:slug and the lock keys numbers by slug, so a
  // document's questions are the same questions after it moves.
  const after = await liveView(env);
  assert.deepEqual(numbers(after), before);
  assert.equal(after.manifest.questions.find((q) => q.slug === 'first-audience').doc, 'guides/plan');
  assert.equal((await item(env, 'content/plan.md')).error, 'no such item', 'the old row is gone');
  const moved = await item(env, 'content/guides/plan.md');
  assert.equal(moved.body, it.body);
  assert.equal(moved.status, it.status);
  assert.equal((await env.DB.prepare("SELECT doc FROM comments WHERE id = 'c1'").first()).doc, 'guides/plan');
  const history = (await body(env, get('/api/content/revisions?path=content%2Fplan.md', EDITOR))).j.revisions;
  assert.equal(history[0].note, 'moved to content/guides/plan.md', 'the old path records why it ended');
  assert.equal((await go(env, get('/guides/plan/', ADMIN))).status, 200);
  assert.equal((await go(env, get('/plan/', ADMIN))).status, 404);
});

test('a document moved away can be moved back: the path’s history continues, it does not collide', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  assert.equal((await batch(env, { moves: [{ from: 'content/plan.md', to: 'content/guides/plan.md', base_revision: it.revision }] })).r.status, 200);
  const there = await item(env, 'content/guides/plan.md');
  const back = await batch(env, { moves: [{ from: 'content/guides/plan.md', to: 'content/plan.md', base_revision: there.revision }] });
  assert.equal(back.r.status, 200, JSON.stringify(back.j));
  const home = await item(env, 'content/plan.md');
  const history = (await body(env, get('/api/content/revisions?path=content%2Fplan.md', EDITOR))).j.revisions;
  assert.equal(home.revision, history[0].revision);
  assert.deepEqual(history.map((h) => h.revision), [3, 2, 1], 'imported, moved away, moved back');
  assert.equal((await go(env, get('/plan/', ADMIN))).status, 200);
});

test('rows: a contributor’s script cannot run, for an admin or anyone (a CSP on every rendered page)', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  assert.equal((await save(env, 'content/plan.md', { body: `${it.body}\n\n<script>fetch('/api/admin/people')</script>\n` })).r.status, 200);
  for (const p of ['/plan/', '/', '/activity/']) {
    const csp = (await go(env, get(p, ADMIN))).headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'(;|$)/, p);
    assert.doesNotMatch(csp, /unsafe-inline/, p);
  }
  // Git content is reviewed as commits: its pages are left as they were.
  const git = await bandEnv();
  assert.equal((await go(git, get('/plan/', ADMIN))).headers.get('content-security-policy'), null);
});

test('a moved site still round-trips: the export compiles to the live digest', async () => {
  const { env } = await rowsSite();
  const it = await item(env, 'content/plan.md');
  await batch(env, { moves: [{ from: 'content/plan.md', to: 'content/guides/plan.md', base_revision: it.revision }] });
  const ex = (await body(env, get('/api/content/export', null, { headers: { authorization: `Bearer ${TOKEN}` } }))).j;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-export-'));
  try {
    for (const [f, text] of Object.entries(ex.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
    assert.equal(ex.files['content/plan.md'], undefined);
    const r = compile({ root: dir });
    assert.deepEqual(r.errors, []);
    assert.equal(digest(r.manifest, r.fragments, sourcesOf(dir, r.manifest)), ex.live.digest);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one stale path refuses the whole batch and nothing is written', async () => {
  const { env } = await rowsSite();
  const plan = await item(env, 'content/plan.md');
  const summary = await item(env, 'content/summary.md');
  const before = { revs: await count(env, 'content_revisions'), versions: await count(env, 'site_versions') };
  const r = await batch(env, { changes: [
    { path: 'content/summary.md', base_revision: summary.revision, body: summary.body + '\nEdited.\n' },
    { path: 'content/plan.md', base_revision: plan.revision - 1, body: plan.body + '\nStale.\n' },
  ] });
  assert.equal(r.r.status, 409);
  assert.match(r.j.error, /content\/plan\.md/);
  assert.deepEqual({ revs: await count(env, 'content_revisions'), versions: await count(env, 'site_versions') }, before);
  assert.equal((await item(env, 'content/summary.md')).body, summary.body);
});

test('a batch that does not compile writes nothing, the move included', async () => {
  const { env } = await rowsSite();
  const plan = await item(env, 'content/plan.md');
  const summary = await item(env, 'content/summary.md');
  const before = { items: await count(env, 'content_items'), revs: await count(env, 'content_revisions'), versions: await count(env, 'site_versions') };
  const r = await batch(env, {
    moves: [{ from: 'content/plan.md', to: 'content/guides/plan.md', base_revision: plan.revision }],
    changes: [{ path: 'content/summary.md', base_revision: summary.revision, body: summary.body + '\n:::question{slug=first-audience audience=team group=scope asked=r1}\nA duplicate slug.\n:::\n' }],
  });
  assert.equal(r.r.status, 422, JSON.stringify(r.j));
  assert.deepEqual({ items: await count(env, 'content_items'), revs: await count(env, 'content_revisions'), versions: await count(env, 'site_versions') }, before);
  assert.equal((await item(env, 'content/plan.md')).body, plan.body, 'the original is still there');
});

test('a batch refuses a move onto an existing path, a path twice, and About', async () => {
  const { env } = await rowsSite();
  const plan = await item(env, 'content/plan.md');
  const onto = await batch(env, { moves: [{ from: 'content/plan.md', to: 'content/summary.md', base_revision: plan.revision }] });
  assert.equal(onto.r.status, 400);
  assert.match(onto.j.error, /already exists/);
  const twice = await batch(env, {
    moves: [{ from: 'content/plan.md', to: 'content/guides/plan.md', base_revision: plan.revision }],
    changes: [{ path: 'content/plan.md', base_revision: plan.revision, body: 'x' }],
  });
  assert.equal(twice.r.status, 400);
  assert.match(twice.j.error, /twice/);
  const about = await batch(env, { moves: [{ from: 'README.md', to: 'content/about.md', base_revision: 1 }] });
  assert.equal(about.r.status, 400);
  assert.equal((await go(env, send('POST', '/api/content/batch', READER, { changes: [{ path: 'content/plan.md', base_revision: 1, body: 'x' }] }))).status, 403);
});
