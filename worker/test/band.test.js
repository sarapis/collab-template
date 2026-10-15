// The band layout (`site.layout: band`), served by the Worker for one viewer.
//
// Each feature HOST-CONTRACT.md Part 2 calls PORTABLE is asserted here as what a
// reader is actually served, and the gate's own detectors run over those pages.
// ⚠️ Most of these are assertions of what a viewer CANNOT see. A layout that
// renders is easy to notice; one that leaks a members-only title into a count
// looks exactly like one that works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { handleMcp } from '../src/mcp.js';
import { MCP_HANDLERS } from '../src/index.js';
import * as d from '../../test/detectors.js';
import { bandEnv, sampleVersion, get, read, ADMIN, READER, host } from './fixture.js';

const fetch = (env, p, who) => worker.fetch(get(p, who), env);
const html = async (env, p, who) => { const r = await fetch(env, p, who); return { r, body: await r.text() }; };
const CSS = read('design/tokens.css') + read('site/site.css') + read('site/band.css') + read('widget/collab.css');

const plan = (v) => v.manifest.questions.find((q) => q.slug === 'first-audience');

test('Home: the band, the pills, the Tools box, the rail and the version footer', async () => {
  const v = sampleVersion();
  const env = await bandEnv({ version: v });
  const { r, body } = await html(env, '/', ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(body, /<header class="band">/);
  assert.match(body, /<nav class="crumbs" aria-label="Breadcrumb"><a href="\/">Sample Project<\/a><\/nav>/);
  const pills = body.match(/<nav class="pills"[\s\S]*?<\/nav>/)[0];
  assert.equal((pills.match(/aria-current="page"/g) || []).length, 1, 'exactly one pill is current');
  assert.match(pills, /href="\/plan\/"/);
  for (const t of ['/about/', '/activity/', '/questions/', '/get-involved/']) assert.match(body, new RegExp(`class="tool" href="${t}"`));
  assert.match(body, /class="rail-docs"[\s\S]*href="\/plan\/"/);
  assert.match(body, new RegExp(`data-digest="${v.digest}"`), 'the footer names the live version’s digest');
  assert.match(body, /from commit <code>abc1234<\/code>/);
});

test('Home counts are the manifest’s, never typed', async () => {
  const v = sampleVersion();
  const { body } = await html(await bandEnv({ version: v }), '/', ADMIN);
  const c = v.manifest.counts;
  assert.match(body, new RegExp(`<strong class="home-figure">${c.open}</strong><span class="counts">open of ${c.visible}</span>`));
  assert.match(body, new RegExp(`${c.questions} questions · ${c.open} open · ${c.resolved} resolved · ${c.documents} documents`));
});

test('Home tells a signed-in person how many questions wait on them', async () => {
  const { body } = await html(await bandEnv(), '/', ADMIN);
  // The admin is in `team`, which first-audience is addressed to, and has not answered it.
  assert.match(body, /1 waiting for you/);
});

test('the Tools box starts as project.tools says, with no script', async () => {
  const closed = sampleVersion();
  assert.doesNotMatch((await html(await bandEnv({ version: closed }), '/', ADMIN)).body, /id="tools-check" checked/);
  const open = sampleVersion();
  open.manifest.project.tools = 'open';
  assert.match((await html(await bandEnv({ version: open }), '/', ADMIN)).body, /id="tools-check" checked/);
});

test('About replaces Start here and the Summary; Decisions are Activity', async () => {
  const env = await bandEnv();
  for (const [from, to] of [['/start/', '/about/'], ['/summary/', '/about/'], ['/decisions/', '/activity/?type=decisions']]) {
    const r = await fetch(env, from, ADMIN);
    assert.equal(r.status, 301, from);
    assert.equal(r.headers.get('location'), to, from);
  }
  const { body } = await html(env, '/about/', ADMIN);
  assert.match(body, /<h2 id="where-things-stand">Where things stand<\/h2>/);
  assert.match(body, /aria-current="page" title="About"|href="\/about\/" aria-current="page"/);
});

test('Activity filters by type and tags decisions about the site', async () => {
  const v = sampleVersion();
  v.manifest.project.site_decisions = ['decisions/2026-10-01-one-site'];
  const env = await bandEnv({ version: v });
  const all = (await html(env, '/activity/', ADMIN)).body;
  const kinds = new Set([...all.matchAll(/data-type="(\w+)"/g)].map((m) => m[1]));
  for (const k of ['decisions', 'posts', 'questions', 'updates']) assert.ok(kinds.has(k), `the unfiltered feed has ${k}`);
  const only = (await html(env, '/activity/?type=decisions', ADMIN)).body;
  const types = [...only.matchAll(/data-type="(\w+)"/g)].map((m) => m[1]);
  assert.ok(types.length > 0, 'the filter kept something');
  assert.deepEqual([...new Set(types)], ['decisions']);
  assert.match(only, /<span class="tag">About this site<\/span>/);
  assert.match(only, /href="\/activity\/\?type=decisions" aria-pressed="true"/);
});

test('Activity carries answers and comments, credited, from the database', async () => {
  const v = sampleVersion();
  const env = await bandEnv({ version: v });
  await env.DB.prepare('INSERT INTO answers (id, question_id, author_sub, author_name, body, created_at, revision_count) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .bind('a1', plan(v).id, READER, 'Reader Person', 'The team first.', '2026-10-05T00:00:00Z').run();
  const { body } = await html(env, '/activity/?type=answers', ADMIN);
  assert.match(body, /Reader Person on <a href="\/questions\/#q1">Q1<\/a>/);
  assert.match(body, /The team first\./);
});

test('question topics carry their names, in the order declared', async () => {
  const v = sampleVersion();
  v.manifest.project.groups = [{ key: 'scope', label: 'Scope and audience' }];
  const { body } = await html(await bandEnv({ version: v }), '/questions/', ADMIN);
  assert.match(body, /<h2 id="g-scope">Scope and audience<\/h2>/);
});

test('Get involved: the project’s own words, then the ways in this Worker offers', async () => {
  const { body } = await html(await bandEnv(), '/get-involved/', ADMIN);
  assert.match(body, /<h2 id="ways-in">Ways in<\/h2>/);
  assert.match(body, /https:\/\/collab\.test\/mcp/);
  assert.match(body, /https:\/\/collab\.test\/connect/);
  assert.match(body, /href="\/auth\/login"/);
});

test('a page Eleventy built is wrapped in the same layout', async () => {
  const env = await bandEnv({ pages: { '/admin/people/': '<!--collab:band {"title":"People","doc":""}-->\n<h1>People</h1><h2 id="who">Who</h2>' } });
  const { body } = await html(env, '/admin/people/', ADMIN);
  assert.match(body, /<header class="band">/);
  assert.match(body, /<main><h1>People<\/h1>/);
  assert.match(body, /<a href="#who">Who<\/a>/, 'its contents list is made from its headings');
  assert.match(body, /<span aria-current="page">People<\/span>/);
});

test('the build’s version file is never served, to anyone', async () => {
  const env = await bandEnv({ publicRead: true });
  for (const who of [null, ADMIN]) assert.equal((await fetch(env, '/_build/version.json', who)).status, 404);
});

test('a private band site still sends a stranger to sign in', async () => {
  const r = await fetch(await bandEnv(), '/plan/', null);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/auth\/login/);
});

// --- the per-item gate --------------------------------------------------------

async function membersOnly() {
  const v = sampleVersion();
  v.statuses = { plan: 'members' };
  const env = await bandEnv({ version: v, publicRead: true });
  await env.DB.prepare('INSERT INTO answers (id, question_id, author_sub, author_name, body, created_at, revision_count) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .bind('a1', plan(v).id, READER, 'Reader', 'SECRET-ANSWER', '2026-10-05T00:00:00Z').run();
  return { v, env };
}
const SENTINEL = 'Who is the first reader this site has to serve';

test('members-only: a stranger is answered exactly as for a page that does not exist', async () => {
  const { env } = await membersOnly();
  const hidden = await fetch(env, '/plan/', null);
  const missing = await fetch(env, '/no-such-page/', null);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.headers.get('cache-control'), 'no-store');
  assert.equal(await hidden.text(), await missing.text());
});

test('members-only: no page, list, count or file tells a stranger it exists', async () => {
  const { v, env } = await membersOnly();
  for (const p of ['/', '/questions/', '/activity/', '/about/', '/get-involved/', '/manifest.json', '/sections.json']) {
    const body = await (await fetch(env, p, null)).text();
    assert.ok(!body.includes(SENTINEL), `${p} carries the members-only question`);
    assert.ok(!body.includes('The plan'), `${p} names the members-only document`);
    assert.ok(!body.includes('SECRET-ANSWER'), `${p} carries an answer to it`);
  }
  const m = await (await fetch(env, '/manifest.json', null)).json();
  assert.equal(m.counts.questions, 0, 'the counts are the stranger’s, recomputed');
  assert.ok(v.manifest.counts.questions > 0, 'and the unfiltered count was not zero');
  assert.equal((await fetch(env, '/source/plan.md', null)).status, 404);
});

test('members-only: the API refuses a stranger its answers and comments', async () => {
  const { v, env } = await membersOnly();
  await env.DB.prepare('INSERT INTO comments (id, thread, doc, author_sub, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('c1', 'general', 'plan', READER, 'Reader', 'SECRET-COMMENT', '2026-10-05T00:00:00Z').run();
  const a = await (await fetch(env, `/api/answers?q=${encodeURIComponent(plan(v).id)}`, null)).json();
  assert.deepEqual(a.answers, {});
  const c = await (await fetch(env, '/api/comments?doc=plan', null)).json();
  assert.ok(!JSON.stringify(c).includes('SECRET-COMMENT'));
});

test('members-only: MCP does not list it, read it or quote it to a stranger', async () => {
  const { env } = await membersOnly();
  const call = async (name, args) => {
    const req = new Request('https://collab.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return JSON.stringify(await (await handleMcp(req, env, { authenticated: false, can_write: false, audiences: [] }, MCP_HANDLERS)).json());
  };
  assert.ok(!(await call('list_documents', {})).includes('"plan"'));
  assert.ok(!(await call('read_document', { slug: 'plan' })).includes(SENTINEL));
  assert.ok(!(await call('list_questions', {})).includes('SECRET-ANSWER'));
});

test('members-only: MCP reads the live version, so a member is shown it', async () => {
  // The other half of the test above: a stranger seeing nothing must be the
  // filter working, not MCP failing to read anything at all.
  const { env } = await membersOnly();
  const req = new Request('https://collab.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_document', arguments: { slug: 'plan' } } }) });
  const me = { authenticated: true, can_write: true, sub: READER, audiences: [] };
  assert.ok(JSON.stringify(await (await handleMcp(req, env, me, MCP_HANDLERS)).json()).includes(SENTINEL));
});

test('members-only: somebody on the roster sees it, under a banner', async () => {
  const { env } = await membersOnly();
  const { r, body } = await html(env, '/plan/', READER);
  assert.equal(r.status, 200);
  assert.match(body, /class="status-banner members"/);
  assert.ok(body.includes(SENTINEL));
});

test('archived: the address still opens, with a banner, and it has left the menus and lists', async () => {
  const v = sampleVersion();
  v.statuses = { plan: 'archived' };
  const env = await bandEnv({ version: v });
  const { r, body } = await html(env, '/plan/', ADMIN);
  assert.equal(r.status, 200);
  assert.match(body, /class="status-banner archived"/);
  const home = (await html(env, '/', ADMIN)).body;
  assert.doesNotMatch(home.match(/<nav class="pills"[\s\S]*?<\/nav>/)[0], /\/plan\//);
  assert.doesNotMatch(home.match(/<nav class="rail-section"[\s\S]*?<\/nav>/)[0], /\/plan\//);
});

// --- the gate's own detectors, over what the Worker serves -------------------

async function served() {
  const v = sampleVersion();
  v.statuses = {};
  const env = await bandEnv({ version: v });
  const paths = ['/', '/about/', '/get-involved/', '/questions/', '/activity/', '/activity/?type=decisions',
    ...v.manifest.docs.filter((x) => !x.partial && x.slug !== 'start').map((x) => `/${x.slug}/`)];
  return Promise.all(paths.map(async (p) => ({ path: p, html: (await html(env, p, ADMIN)).body })));
}

test('band pages: every class used is styled', async () => {
  const pages = await served();
  assert.ok(pages.length >= 7);
  assert.deepEqual(d.unstyledClasses(pages, CSS), []);
});
test('band pages: the unstyled-class check can see an unstyled band class', () => {
  assert.equal(d.unstyledClasses([{ path: '/', html: '<p class="band-nonsense"></p>' }], CSS).length, 1);
});
test('band pages: in-page anchors all resolve', async () => assert.deepEqual(d.danglingInPageAnchors(await served()), []));
test('band.css uses only tokens the design system defines', () => {
  assert.deepEqual(d.undefinedTokens(read('site/band.css'), read('design/tokens.css')), []);
  assert.equal(d.undefinedTokens('a{color:var(--band-typo)}', read('design/tokens.css')).length, 1);
});
test('band.css hard-codes no colour', () => {
  const css = read('site/band.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) || [], []);
});

test('classic is untouched: without the setting no band page is rendered', async () => {
  const env = await bandEnv();
  env.COLLAB_HOST = host({ layout: 'classic' });
  const r = await fetch(env, '/about/', ADMIN);
  assert.equal(r.status, 404, 'classic serves /about/ from the assets, which have none');
});
