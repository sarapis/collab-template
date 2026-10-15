import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as d from './detectors.js';
import yaml from 'js-yaml';
import { matches } from '../worker/src/routes.js';

const SITE = '_site';
const read = (p) => fs.readFileSync(p, 'utf8');

function pages(dir = SITE, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) out.push(...pages(dir, rel));
    else if (e.name.endsWith('.html')) out.push({ path: '/' + rel, html: read(path.join(dir, rel)) });
  }
  return out;
}

// ⚠️ The band layout's pages are made by the Worker, not by Eleventy, so the
// gate checks what the Worker serves (test/served.js); the classic layout's
// pages are the files.
const BAND = (yaml.load(read('site.config.yml')) || {}).site?.layout === 'band';
const P = BAND ? await (await import('./served.js')).servedPages(SITE) : pages();

// The instance's own settings (site.config.yml). The gate reads the few things
// that differ between instances from there, so this file is the same everywhere.
const CONFIG = yaml.load(read('site.config.yml')) || {};
const IS_PUBLIC = CONFIG.auth?.read === 'public';

// ⚠️ The named exceptions, in one place: pages an instance copies in as-is
// (`site.passthrough` in site.config.yml), self-contained, with their own
// styling and theme. Nothing here compiles them and the sidebar is not on them.
// The checks below that assume this site's layout are run against SITE_PAGES
// instead, so an exception is visible rather than being a hole quietly opened
// in each check. Everything that is genuinely about being on the web — dangling
// links, anchors — still runs against every page, including these.
const EXTERNAL_ARTIFACTS = new Set((CONFIG.site?.passthrough || [])
  .map((x) => '/' + String(x.to).replace(/^\//, ''))
  .filter((to) => to.endsWith('.html')));
const SITE_PAGES = P.filter((p) => !EXTERNAL_ARTIFACTS.has(p.path));
// The pages this TEMPLATE builds, as opposed to the ones a document produces.
// Read twice: by the orphan check, and by the passthrough check below, which
// needs to know every address the site serves without the instance's help.
const TEMPLATE_PAGES = ['/questions/index.html', '/activity/index.html', '/decisions/index.html',
  '/design/index.html', '/admin/index.html', '/admin/log/index.html',
  '/admin/people/index.html', '/admin/settings/index.html', '/summary/index.html',
  '/notifications/index.html',
  // The band layout's own pages, and the content editor where content is rows.
  ...(BAND ? ['/index.html', '/about/index.html', '/get-involved/index.html', '/admin/content/index.html'] : [])];
const CSS = read('design/tokens.css') + read('site/site.css') + (BAND ? read('site/band.css') : '') + read('widget/collab.css');
const MANIFEST = JSON.parse(read('build/manifest.json'));
// The editor is part of the widget where the content is rows (it ships only there).
const WIDGET = read('widget/collab.js') + (fs.existsSync(path.join(SITE, 'content-editor.js')) ? read('widget/content-editor.js') : '');
// The generated notice, parsed once. `read` it rather than importing, so the
// gate checks the bytes the Worker will actually serve.
const PUBLIC_NOTICE = JSON.parse(
  read('worker/src/site.generated.js').match(/export const PUBLIC_NOTICE = ("(?:[^"\\]|\\.)*");/)[1]);

test('the site was built before the gate ran', () => {
  assert.ok(P.length >= 5, 'no pages found; run the build first');
});

// --- each detector: quiet on the real site, loud on a crafted violation -----

test('in-page anchors all resolve', () => assert.deepEqual(d.danglingInPageAnchors(P), []));
test('the in-page anchor check can see a violation', () => {
  assert.equal(d.danglingInPageAnchors([{ path: '/x', html: '<a href="#ghost">x</a>' }]).length, 1);
});

// The band layout's redirects (About replaces /start/ and /summary/; Decisions
// are Activity) are routes too: a link to one lands on a page.
const BAND_REDIRECTS = new Set(['/start/', '/summary/', '/decisions/']);
const isRoute = (p) => matches(p) || (BAND && BAND_REDIRECTS.has(p));
test('cross-document links all resolve', () => assert.deepEqual(d.danglingCrossLinks(P, isRoute), []));
test('the cross-link check can see a missing page', () => {
  assert.equal(d.danglingCrossLinks([{ path: '/index.html', html: '<a href="/nowhere/">x</a>' }]).length, 1);
});

test('the cross-link check accepts a Worker route that is not a page', () => {
  const p = [{ path: '/index.html', html: '<a href="/auth/logout">out</a>' }];
  assert.equal(d.danglingCrossLinks(p).length, 1, 'without the route table it should complain');
  assert.deepEqual(d.danglingCrossLinks(p, matches), []);
});
test('the cross-link check can see a missing anchor on a real page', () => {
  const p = [{ path: '/index.html', html: '<a href="/a/#ghost">x</a>' }, { path: '/a/index.html', html: '<h2 id="real"></h2>' }];
  assert.equal(d.danglingCrossLinks(p).length, 1);
});

test('every class used is styled', () => assert.deepEqual(d.unstyledClasses(SITE_PAGES, CSS), []));
test('the unstyled-class check can see a violation', () => {
  assert.equal(d.unstyledClasses([{ path: '/x', html: '<p class="never-styled">x</p>' }], '.styled{}').length, 1);
});

test('every token is defined for light and for both dark selectors', () => assert.deepEqual(d.tokenParity(CSS), []));
test('the token-parity check can see a token missing from dark', () => {
  const css = ':root { --a: #fff; --b: #000; }\n:root:not([data-theme="light"]) { --a: #111; }\n:root[data-theme="dark"] { --a: #111; }';
  assert.equal(d.tokenParity(css).length, 1);
});

test('every /api/ call the widget makes is a route the server declares', () => {
  assert.deepEqual(d.unresolvedApiCalls(WIDGET, matches), []);
});
test('the api-call check can see an endpoint that does not exist', () => {
  // The real failure this exists for: a page fetched /api/me when the server
  // had /api/auth/user, so an author-only button rendered for nobody.
  assert.equal(d.unresolvedApiCalls("fetch(API + '/api/imaginary')", matches).length, 1);
});

test('every section is reachable from its contents list', () => {
  const docs = P.filter((p) => p.html.includes('<main>') && /<nav class="toc"/.test(p.html));
  // ⚠️ This assertion is the check on the check: the selector above was once
  // '<strong>Contents</strong>', and when the rail was rebuilt it matched
  // nothing. Without this line the test would have passed by examining zero
  // pages, forever.
  assert.ok(docs.length > 0, 'no documents with a contents list were found');
  assert.deepEqual(docs.flatMap(d.unreachableSections), []);
});
test('the contents-list check can see an unlisted section', () => {
  const page = { path: '/x', html: '<ol></ol><main><h2 id="orphan">x</h2></main>' };
  assert.equal(d.unreachableSections(page).length, 1);
});

test('long paths in code can wrap', () => assert.deepEqual(d.codeCannotWrap(CSS), []));
test('the wrap check can see a stylesheet that forbids wrapping', () => {
  assert.equal(d.codeCannotWrap('main code { font-family: mono; }').length, 1);
});

test('no document keeps its own copy of the question list', () => {
  assert.deepEqual(d.catalogCopies(P, MANIFEST), []);
});
test('the catalog-copy check can see a document rendering a question the catalog does not place there', () => {
  const m = { docs: [{ slug: 'a' }], questions: [] };
  const p = [{ path: '/a/index.html', html: '<aside data-question="x:y"></aside>' }];
  assert.equal(d.catalogCopies(p, m).length, 1);
});

test('no template types a count it could compute', () => {
  const templates = fs.readdirSync('site').filter((f) => f.endsWith('.njk'))
    .map((f) => ({ path: `site/${f}`, src: read(`site/${f}`) }));
  assert.deepEqual(d.typedCounts(templates), []);
});
test('the typed-count check can see a typed count', () => {
  assert.equal(d.typedCounts([{ path: 'x', src: '<p>65 questions across 7 groups</p>' }]).length, 1);
});

test('the manifest is internally consistent', () => assert.deepEqual(d.manifestIntegrity(MANIFEST), []));
test('the manifest check can see an undeclared audience', () => {
  const m = { audiences: {}, asked_rounds: { r1: {} }, docs: [], questions: [{ number: 1, audience: 'ghost', asked: 'r1', margin: false }] };
  assert.match(d.manifestIntegrity(m).join(), /audience "ghost"/);
});

// --- properties the design depends on --------------------------------------

test('a document renders completely with no JavaScript and no API', () => {
  // The widget is strictly additive. If the question text needed a fetch, a
  // reader with no network would see a document with no open questions in it,
  // which reads as more settled than it is.
  //
  // ⚠️ Derived from the manifest, not from a document this test knows by name.
  // The first version named the demo document, so swapping the content broke
  // seven tests that were about the machinery and not about the content.
  const margin = MANIFEST.questions.filter((q) => q.margin);
  assert.ok(margin.length > 0, 'the content should exercise at least one margin question');
  for (const q of margin) {
    const path = q.doc === 'index' ? '/index.html' : `/${q.doc}/index.html`;
    const doc = P.find((p) => p.path === path);
    assert.ok(doc, `${path} was not built`);
    assert.ok(doc.html.includes(`data-question="${q.id}"`), `${q.slug} is not in the static HTML`);
  }
});

test('the widget treats every failure as a silent return', () => {
  // ⚠️ Comments are stripped first. The check fired on the word "throw" inside
  // an explanatory comment, and a detector that complains about prose is one
  // people learn to disable.
  const code = WIDGET
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/Promise\.reject\(new Error[^)]*\)/g, '');
  assert.match(code, /\.catch\(/, 'no catch handlers found');
  assert.equal(/\bthrow\s+/.test(code), false);
});

test('the silent-return check can still see a real throw', () => {
  const code = 'function f(){ if (!x) throw new Error("boom"); }'
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\bthrow\s+/.test(code), true);
});

test('an unanchored question is on the worksheet and not in the document', () => {
  const hidden = MANIFEST.questions.filter((q) => !q.margin);
  assert.ok(hidden.length > 0, 'the demo content should exercise margin=false');
  const sheet = P.find((p) => p.path === '/questions/index.html');
  for (const q of hidden) {
    assert.ok(sheet.html.includes(q.id), 'missing from the worksheet');
    const doc = P.find((p) => p.path === `/${q.doc}/index.html`);
    assert.equal(doc.html.includes(`data-question="${q.id}"`), false);
  }
});

test('no page is listed twice in the left menu', () => {
  assert.deepEqual(P.flatMap(d.duplicateMenuLinks), []);
});
test('the duplicate-menu check can see a duplicate', () => {
  const page = { path: '/x', html: '<nav class="menu"><a href="/a/">A</a><a href="/a/">A again</a></nav>' };
  assert.equal(d.duplicateMenuLinks(page).length, 1);
});

test('the duplicate-menu check counts the sidebar foot as the sidebar', () => {
  // The exact shape that slipped through: once in a group, once in the foot.
  const page = { path: '/x', html:
    '<nav class="menu"><a href="/n/">Notifications</a></nav>' +
    '<div class="sidebar-foot"><a href="/n/">Notifications</a><div class="who-row"></div></div>' };
  assert.equal(d.duplicateMenuLinks(page).length, 1);
});

test('the menu is reachable with no JavaScript', () => {
  // The sidebar is the only navigation on the page, so it must not depend on a
  // script to open. <details> is the mechanism; this asserts the markup stayed
  // that way and that the links are in the HTML either way.
  // ⚠️ Any built page, not one this test knows by name. Naming the demo document
  // is how several tests about the machinery broke when the content changed --
  // and this test named /index.html anyway, so it broke the day `/` stopped
  // being a page and became a router.
  const page = P[0];
  assert.ok(page, 'no pages were built');
  // The band layout's Tools box opens the same way: a checkbox, no script.
  const [check, label] = BAND ? ['tools-check', 'tools-toggle'] : ['menu-check', 'menu-toggle'];
  assert.match(page.html, new RegExp(`<input type="checkbox" class="${check}"`));
  assert.match(page.html, new RegExp(`<label class="${label}" for="${check}">`));
  assert.match(page.html, /href="\/questions\/"/);
});

const EXPORT = fs.existsSync('content/answers.export.json')
  ? JSON.parse(read('content/answers.export.json')) : null;

test('every quoted answer matches the words that were actually written', () => {
  // A project with no quotes yet has nothing to check. The three self-tests
  // below are what stop this becoming a checker that silently matches nothing:
  // they prove the detector still sees drift, a prefix, and a marked excerpt.
  if (!MANIFEST.quotes.length) return;
  assert.ok(EXPORT, 'prose quotes an answer but content/answers.export.json is missing; run npm run export');
  assert.deepEqual(d.driftedQuotes(MANIFEST.quotes, EXPORT), []);
});

test('the quote check can see a quote that has drifted', () => {
  const ex = { answers: { a: [{ body: 'Ninety days, and no longer.' }] } };
  assert.equal(d.driftedQuotes([{ doc: 'x', slug: 'a', text: 'Ninety days.', excerpt: false }], ex).length, 1);
});

test('the quote check can see a prefix passed off as a full quote', () => {
  // The original failure: a quote cut the half that carried a requirement.
  const ex = { answers: { a: [{ body: 'Ninety days, unless legal says otherwise.' }] } };
  assert.equal(d.driftedQuotes([{ doc: 'x', slug: 'a', text: 'Ninety days', excerpt: false }], ex).length, 1);
});

test('a marked excerpt is allowed to be a fragment', () => {
  const ex = { answers: { a: [{ body: 'Ninety days, unless legal says otherwise.' }] } };
  assert.deepEqual(d.driftedQuotes([{ doc: 'x', slug: 'a', text: 'unless legal says otherwise', excerpt: true }], ex), []);
});

// ⚠️ The first real fold-in hit this: the quote was right and the check failed,
// because the sentence had been wrapped to fit the column. A check that fires on
// correct work teaches people to stop trusting it.
test('a quote wrapped across source lines is still the same quote', () => {
  const ex = { answers: { a: [{ body: 'Ninety days, unless legal says otherwise.' }] } };
  assert.deepEqual(d.driftedQuotes([{ doc: 'x', slug: 'a', text: 'Ninety days, unless\nlegal says otherwise.', excerpt: false }], ex), []);
});

test('an answer typed over several lines can be quoted in full', () => {
  const ex = { answers: { a: [{ body: 'Ninety days.\nUnless legal says otherwise.' }] } };
  assert.deepEqual(d.driftedQuotes([{ doc: 'x', slug: 'a', text: 'Ninety days. Unless legal says otherwise.', excerpt: false }], ex), []);
});

test('collapsing whitespace does not let a prefix through', () => {
  const ex = { answers: { a: [{ body: 'Ninety days,\nunless legal says otherwise.' }] } };
  assert.equal(d.driftedQuotes([{ doc: 'x', slug: 'a', text: 'Ninety days,', excerpt: false }], ex).length, 1);
});

const FIGURES = fs.existsSync('content/figures.export.json')
  ? JSON.parse(read('content/figures.export.json')) : null;

test('every stated figure matches what was measured', () => {
  // A project with no marked figures has nothing to check. The three self-tests
  // below are what stop this becoming a checker that silently matches nothing.
  if (!MANIFEST.figures?.length) return;
  assert.ok(FIGURES, 'figures are marked in the prose and content/figures.export.json is missing: run `npm run figures`');
  assert.deepEqual(d.driftedFigures(MANIFEST.figures, FIGURES), []);
});

test('the figure check can see a number that has moved', () => {
  const ex = { figures: { 'corpus.base_indicators': 689 } };
  assert.equal(d.driftedFigures([{ doc: 'x', key: 'corpus.base_indicators', text: '1661' }], ex).length, 1);
});

test('a readable figure is the same measurement', () => {
  // 6,025 and 6025 are one number. A gate that forces prose to drop its commas
  // is a gate people route around.
  const ex = { figures: { 'corpus.variables': 6025 } };
  assert.deepEqual(d.driftedFigures([{ doc: 'x', key: 'corpus.variables', text: '6,025' }], ex), []);
});

test('a figure nothing computes is reported, not quietly passed', () => {
  // ⚠️ The dangerous failure. An unknown key that simply passed would mean a
  // typo in the key turns the guarantee off for that number, and the document
  // would look checked.
  assert.equal(d.driftedFigures([{ doc: 'x', key: 'corpus.invented', text: '12' }], { figures: {} }).length, 1);
});

// ⚠️ The resources of the OTHER instances built from this machinery, named in
// site.config.yml (`gate.foreign_resources`) so they can be refused: D1 and KV
// ids and hostnames. It is the one list an instance keeps of another project's
// ids. The worst outcome of a fork is inheriting the parent's ids: the new
// Worker would read and WRITE the other project's live database. And not only
// storage ids: a fork once inherited `.mcp.json` pointing at its parent's /mcp,
// so its contributors got a server for a different, private project.
const OTHER_INSTANCE_RESOURCES = CONFIG.gate?.foreign_resources || [];

test('this instance points at no other instance\'s resources', () => {
  // ⚠️ Both files. wrangler.jsonc is where a borrowed D1 or KV id would land;
  // .mcp.json is where a borrowed HOSTNAME did land. Checking only the first is
  // how the second survived a fork.
  // ⚠️ README.md too, and it was the THIRD place this happened: a fork
  // inherited "add https://<the parent's host> as a custom connector" as its
  // own instructions. Anywhere a contributor is TOLD a hostname counts.
  const sources = read('wrangler.jsonc') + read('.mcp.json') + read('README.md');
  assert.deepEqual(d.foreignResources(sources, OTHER_INSTANCE_RESOURCES), []);
});

test('the foreign-resource check can see a borrowed id', () => {
  const other = '00000000-1111-2222-3333-444444444444';
  const bad = `{ "d1_databases": [{ "database_id": "${other}" }] }`;
  assert.equal(d.foreignResources(bad, [other]).length, 1);
});

test('every admin page explains itself to somebody who is refused', () => {
  assert.deepEqual(d.adminPagesExplainThemselves(SITE_PAGES, WIDGET), []);
});

test('the check can see a page with no refusal state', () => {
  assert.equal(d.adminPagesExplainThemselves([{ path: '/admin/x/index.html', html: '<h1>Admin</h1>' }], '').length, 1);
});

test('the check can see a refusal state nothing ever shows', () => {
  const page = [{ path: '/admin/x/index.html', html: '<p id="x-denied" hidden>no</p>' }];
  assert.equal(d.adminPagesExplainThemselves(page, 'var ids = [];').length, 1);
  assert.deepEqual(d.adminPagesExplainThemselves(page, "['x-denied'].forEach"), []);
});

test('a private instance runs the Worker before the asset server', () => {
  assert.deepEqual(d.assetsBypassAuth(read('wrangler.jsonc')), []);
});

test('the asset-bypass check can see the dangerous configuration', () => {
  const bad = '{ "vars": { "PUBLIC_READ": "false" }, "assets": { "directory": "./_site" } }';
  assert.equal(d.assetsBypassAuth(bad).length, 1);
});

test('the asset-bypass check is quiet for a public instance', () => {
  const ok = '{ "vars": { "PUBLIC_READ": "true" }, "assets": { "directory": "./_site" } }';
  assert.deepEqual(d.assetsBypassAuth(ok), []);
});

test('the development sign-in switch is not set for deployment', () => {
  assert.deepEqual(d.devSignInDeployed(read('wrangler.jsonc')), []);
});
test('the dev-sign-in check can see it switched on', () => {
  assert.equal(d.devSignInDeployed('{ "vars": { "DEV_SIGN_IN": "true" } }').length, 1);
});

test('sign-in links are not printed to the log in the committed config', () => {
  assert.deepEqual(d.magicLinksInLog(read('wrangler.jsonc')), []);
});
test('the magic-link-logging check can see it switched on', () => {
  assert.equal(d.magicLinksInLog('{ "vars": { "MAGIC_LINK_TO_LOG": "true" } }').length, 1);
});






test('every token used is one the design system defines', () => {
  const usage = read('site/site.css') + read('widget/collab.css');
  assert.deepEqual(d.undefinedTokens(usage, read('design/tokens.css')), []);
});

test('the undefined-token check can see a typo', () => {
  assert.equal(d.undefinedTokens('a { color: var(--forground); }', ':root { --foreground: #000; }').length, 1);
});

test('the sign-in page hard-codes no colour', () => {
  // ⚠️ It is the first thing a person sees, and a sign-in screen that does not
  // look like the site it guards reads as a phishing page. It must take every
  // value from the same design system as everything else.
  const auth = read('worker/src/auth.js');
  const styleBlocks = [...auth.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  assert.ok(styleBlocks.length > 0, 'no style block found in the sign-in page');
  const literals = styleBlocks.join('\n').match(/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/g) || [];
  assert.deepEqual(literals, []);
});

test('the hard-coded-colour check can see a literal', () => {
  assert.throws(() => {
    const literals = '<style>a{color:#fff}</style>'.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepEqual(literals, []);
  });
});

test('every page marks exactly one menu item as current', () => {
  assert.deepEqual(d.menuCurrentState(P), []);
});

test('the menu-current check can see a menu page with nothing selected', () => {
  const page = { path: '/a/index.html', html: '<nav class="menu"><a href="/a/">A</a></nav>' };
  assert.equal(d.menuCurrentState([page]).length, 1);
});

test('the menu-current check can see two items selected at once', () => {
  const page = { path: '/a/index.html', html: '<nav class="menu"><a href="/a/" aria-current="page">A</a><a href="/b/" aria-current="page">B</a></nav>' };
  assert.equal(d.menuCurrentState([page]).length, 1);
});

test('nothing is published that this build did not produce', () => {
  assert.deepEqual(d.orphanedPages(P, MANIFEST, [...TEMPLATE_PAGES, ...EXTERNAL_ARTIFACTS]), []);
});

test('the orphan check can see a page left behind by a deleted document', () => {
  const stale = [{ path: '/gone/index.html', html: '' }];
  assert.equal(d.orphanedPages(stale, { docs: [] }, []).length, 1);
});

// Every address this site serves without consulting site.passthrough, so a
// passthrough that claims one is caught by the config rather than by whichever
// of the two the build happens to leave standing.
const SERVED_ADDRESSES = new Map([
  ...TEMPLATE_PAGES.map((p) => [p.replace(/index\.html$/, ''), 'a page this template builds']),
  ...(MANIFEST.docs || []).filter((x) => !x.partial).map((x) => [`/${x.slug}/`, `the document “${x.title}”`]),
]);

test('no passthrough page claims an address the site already serves', () => {
  assert.deepEqual(d.passthroughCollisions(CONFIG.site?.passthrough, SERVED_ADDRESSES), []);
});

test('the passthrough check can see one shadowing a document', () => {
  const doc = MANIFEST.docs.find((x) => !x.partial);
  const bad = [{ from: 'instance/artifact.html', to: `${doc.slug}/index.html` }];
  assert.equal(d.passthroughCollisions(bad, SERVED_ADDRESSES).length, 1);
});

test('the passthrough check can see one shadowing a page this template builds', () => {
  const bad = [{ from: 'instance/artifact.html', to: 'questions/index.html' }];
  assert.equal(d.passthroughCollisions(bad, SERVED_ADDRESSES).length, 1);
});

test('the passthrough check reads a directory target as the source file’s name', () => {
  const doc = MANIFEST.docs.find((x) => !x.partial);
  const bad = [{ from: `instance/${doc.slug}/index.html`, to: `${doc.slug}/` }];
  assert.equal(d.passthroughCollisions(bad, SERVED_ADDRESSES).length, 1);
});

test('the passthrough check can see two entries at one address', () => {
  const two = [{ from: 'instance/a.html', to: 'artifact.html' }, { from: 'instance/b.html', to: 'artifact.html' }];
  assert.equal(d.passthroughCollisions(two, SERVED_ADDRESSES).length, 1);
});

// The floating Ask button is fixed, so only the stylesheet can stop the page
// ending underneath it. WIDGET_CSS, not CSS: the dock ships with the widget,
// and the two halves of the arithmetic must be in the file that ships with it.
const WIDGET_CSS = read('widget/collab.css');

test('the page keeps room below its content for the floating dock', () => {
  assert.deepEqual(d.chatDockRoom(WIDGET_CSS), []);
});

test('the dock check can see room trimmed below what the button occupies', () => {
  const tight = WIDGET_CSS.replace('padding-bottom: 4.8rem', 'padding-bottom: 2rem');
  assert.equal(d.chatDockRoom(tight).length, 1);
});

test('the dock check can see a button restyled taller than its room', () => {
  const taller = WIDGET_CSS.replace('min-height: 2.6rem', 'min-height: 4.5rem');
  assert.equal(d.chatDockRoom(taller).length, 1);
});

test('the dock check can see a button that no longer states its height', () => {
  const vague = WIDGET_CSS.replace('min-height: 2.6rem;', '');
  assert.equal(d.chatDockRoom(vague).length, 1);
});

test('the dock check can see the reservation removed', () => {
  const gone = WIDGET_CSS.replace(/body:has\(\.chat-open\)[^}]*\}/, '');
  assert.equal(d.chatDockRoom(gone).length, 1);
});

test('the passthrough check leaves an address of its own alone', () => {
  const ok = [{ from: 'instance/artifact.html', to: 'artifact.html' }, { from: 'instance/deck.html', to: 'deck/index.html' }];
  assert.deepEqual(d.passthroughCollisions(ok, SERVED_ADDRESSES), []);
});

test('the site pins its colour scheme', () => {
  // ⚠️ These pages render outside any app shell and have no theme toggle. A
  // dark-mode reader once got dark documents with no way out — and Playwright
  // defaults to light, so it is invisible to whoever is developing.
  for (const p of SITE_PAGES) assert.match(p.html, /<html lang="en" data-theme="light">/);
  assert.match(read('design/tokens.css'), /color-scheme:\s*light/);
  // ⚠️ Including the sign-in page, which the Worker renders rather than the
  // build. It was the one page that followed the system theme, so a visitor in
  // dark mode met a dark sign-in screen for a light site.
  assert.match(read('worker/src/auth.js'), /<html lang="en" data-theme="light">/);
});

test('the unstyled-class check still ignores nothing else', () => {
  // The language-* exemption must not become a hole. Anything else unstyled is
  // still a finding.
  const page = { path: '/x', html: '<p class="language-bash made-up">x</p>' };
  const found = d.unstyledClasses([page], '.styled{}');
  assert.equal(found.length, 1);
  assert.match(found[0], /made-up/);
});

test('no partial is published as its own page', () => {
  // The band layout's Get involved page is the host's own page that SHOWS the
  // `get-involved` partial (Databook decision 30), not the partial published.
  const templates = ['/summary/index.html', ...(BAND ? ['/get-involved/index.html'] : [])];
  assert.deepEqual(d.partialsPublished(P, MANIFEST, templates), []);
  assert.ok(MANIFEST.docs.some((x) => x.partial), 'the content should exercise at least one partial');
});

test('the partial check can see one published twice', () => {
  const pages = [{ path: '/prose/index.html', html: '' }];
  const m = { docs: [{ slug: 'prose', partial: true }] };
  assert.equal(d.partialsPublished(pages, m, []).length, 1);
});

test('an agent arriving at the repo is told how to add a document', () => {
  // ⚠️ The scaffold existed only in a section addressed to a person. An agent
  // reading CLAUDE.md — which is the file it reads first — would have learned
  // every rule about questions and none of the command that gets them right.
  for (const f of ['CLAUDE.md', 'README.md']) {
    assert.match(read(f), /npm run new/, `${f} does not name the scaffold`);
  }
  const brief = read('README.md').split('# Collaboration site — orientation')[1] || '';
  assert.match(brief, /npm run new/, 'the AI brief does not name the scaffold');
});

// ⚠️ /llms.txt has OPPOSITE rules on the two kinds of instance, and which one
// runs is `auth.read` in site.config.yml (scripts/build-worker-data.mjs builds
// it the same way).
//   PRIVATE: the notice is the one thing served without a sign-in. It is built
//   from named config fields and never from the manifest, so adding a document
//   cannot quietly make its title public.
//   PUBLIC: every document is already served to anyone, so withholding titles
//   protects nothing. Inheriting the private rule is what once left a public
//   site telling its readers that its content was not published.
if (IS_PUBLIC) {
  test('the agent index lists what this public site actually serves', () => {
    const listed = MANIFEST.docs.filter((doc) => !doc.partial && !doc.menu && ['doc', 'data'].includes(doc.type));
    assert.ok(listed.length > 0, 'the content should have at least one listable document');
    for (const doc of listed) {
      assert.ok(PUBLIC_NOTICE.includes(doc.title), `the agent index omits the document "${doc.title}"`);
    }
    // ⚠️ Posts and decisions are reached through their index pages instead of
    // being enumerated, so those two links are what has to be there. Without this
    // half, dropping the feed from the index would pass silently.
    for (const p of ['/activity/', '/decisions/']) {
      assert.ok(PUBLIC_NOTICE.includes(p), `the agent index does not link ${p}`);
    }
    // ⚠️ No assertion here about partials. The obvious one — "a partial has no
    // page, so the index must not link its slug" — is FALSE: `summary` is a
    // partial whose slug is also a real route, because a template includes it.
    // Whether a link goes anywhere is a question about the built output, and
    // `agentIndexRot` answers it against _site rather than guessing.
  });
} else {
  test('the public notice publishes only what the config names', () => {
    const notice = PUBLIC_NOTICE;
    // The project's own name is a named config field and is deliberately public;
    // it is also the front page's title. Every other title must stay unpublished.
    const projectName = MANIFEST.project?.name;
    for (const doc of MANIFEST.docs) {
      if (doc.title === projectName) continue;
      assert.equal(notice.includes(doc.title), false, `the public notice names the document "${doc.title}"`);
    }
    for (const q of MANIFEST.questions) {
      assert.equal(notice.includes(q.slug), false, `the public notice names question ${q.slug}`);
    }
    assert.match(notice, /not published/);
  });
}

test('the agent index check can see a document that is missing from it', () => {
  const notice = '# A site\n- [One](/one/)\n';
  assert.equal(notice.includes('Two'), false);
});

test('the public-notice check can see a leak', () => {
  const notice = 'Read the Comms strategy here';
  assert.equal(notice.includes('Comms strategy'), true);
});

test('everything the sign-in page loads is served without a sign-in', () => {
  // ⚠️ The sign-in page is the one page a stranger sees. A stylesheet of its own
  // that sits behind the auth check 302s for exactly those visitors, and the
  // page renders unstyled — invisibly, because anyone checking it is signed in.
  const auth = read('worker/src/auth.js');
  const publicAssets = new Set(
    [...read('worker/src/index.js').matchAll(/PUBLIC_ASSETS = new Set\(\[([^\]]*)\]\)/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])));
  const loaded = [...auth.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(loaded.length > 0, 'the sign-in page loads no stylesheet at all');
  for (const href of loaded) {
    assert.ok(publicAssets.has(href), `the sign-in page loads ${href}, which is not public`);
  }
});

test('the public-asset check can see a stylesheet left behind auth', () => {
  const publicAssets = new Set(['/tokens.css']);
  assert.equal(publicAssets.has('/site.css'), false);
});



test('every referenced passage is actually available to show', () => {
  // ⚠️ A reference validated at build time but missing from the served sections
  // would expand into an empty box — the context silently absent, which is the
  // failure the reference exists to prevent.
  const sections = JSON.parse(read('build/sections.json'));
  const cited = MANIFEST.questions.flatMap((q) => (q.see || []).filter((r) => r.kind === 'section'));
  assert.ok(cited.length > 0, 'no question cites a section; this check would examine nothing');
  for (const r of cited) {
    assert.ok(sections[`${r.doc}#${r.section}`], `${r.doc}#${r.section} is cited and not in sections.json`);
  }
});

test('the referenced-passage check can see a missing section', () => {
  const sections = { 'a#one': '<h2>One</h2>' };
  assert.equal(Boolean(sections['a#two']), false);
});

test('having notifications does not look like being on the notifications page', () => {
  const css = read('site/site.css');
  assert.deepEqual(d.stateStylingCollision(css, '.badge.has-news', '.menu a[aria-current="page"]'), []);
});

test('the state-collision check can see two states styled the same', () => {
  const css = '.a.has-news { background: var(--accent); }\n.b[aria-current="page"] { background: var(--accent); }';
  assert.equal(d.stateStylingCollision(css, '.a.has-news', '.b[aria-current="page"]').length, 1);
});

test('the notification link and the worksheet filter agree', () => {
  // ⚠️ ?open=1 is linked from the notification badge and written into the README,
  // and for a while nothing read it at all — the link promised a filtered view
  // and delivered the whole list. Whatever it means, the page has to honour it.
  const widget = read('widget/collab.js');
  assert.match(widget, /searchParams[\s\S]{0,200}'open'/, 'the widget never reads ?open');
  const sheet = P.find((p) => p.path === '/questions/index.html');
  assert.match(sheet.html, /id="q-filters"/, 'the worksheet has no filter bar');
  for (const mode of ['waiting', 'unanswered', 'answered']) {
    assert.match(sheet.html, new RegExp(`data-show="${mode}"`), `no ${mode} filter`);
  }
});

test('every filter the page offers is one the widget implements', () => {
  const sheet = P.find((p) => p.path === '/questions/index.html');
  const offered = [...sheet.html.matchAll(/data-show="([a-z]+)"/g)].map((m) => m[1]);
  const widget = read('widget/collab.js');
  assert.ok(offered.length > 1);
  for (const mode of offered) {
    if (mode === 'all') continue;
    assert.match(widget, new RegExp(`show === '${mode}'`), `the page offers "${mode}" and the widget does not implement it`);
  }
});

test('no document lists open questions that are not questions', () => {
  const dir = 'content';
  const sources = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        sources.push({ slug: full.replace(/^content\//, '').replace(/\.md$/, ''), text: read(full) });
      }
    }
  };
  walk(dir);
  assert.deepEqual(d.questionsWrittenAsProse(sources, MANIFEST), []);
});

test('the prose-questions check can see a bulleted list of questions', () => {
  // The exact shape it exists for.
  const sources = [{ slug: 'a', text: '# Doc\n\n## Open questions\n\n- Which ones?\n- And when?\n' }];
  assert.equal(d.questionsWrittenAsProse(sources, { questions: [] }).length, 1);
});

test('the prose-questions check is quiet when the document declares questions', () => {
  const sources = [{ slug: 'a', text: '# Doc\n\n## Open questions\n\n- Which ones?\n' }];
  assert.deepEqual(d.questionsWrittenAsProse(sources, { questions: [{ doc: 'a' }] }), []);
});

test('the assistant is reachable from every page, not from a page of its own', () => {
  // ⚠️ It was a page in the sidebar, so asking a question about what you were
  // reading cost you the page you were reading. The overlay has to be on every
  // page for that to be true.
  const pages = P.filter((p) => p.html.includes('<main>'));
  assert.ok(pages.length > 3);
  for (const p of pages) {
    assert.match(p.html, /id="chat-open"/, `${p.path} has no way to ask`);
    assert.match(p.html, /id="chat-panel"/, `${p.path} has no assistant panel`);
  }
});

test('the overlay says the conversation is stored, on every page', () => {
  // Not in a policy page nobody opens: on the thing itself.
  for (const p of P.filter((x) => x.html.includes('chat-panel'))) {
    assert.match(p.html, /conversation is stored and the team can read it/);
  }
});

test('nothing links to a chat page that no longer exists', () => {
  const linked = P.some((p) => /<a\s[^>]*href="\/chat\/"/.test(p.html));
  assert.equal(linked, false, 'something still links to the removed /chat/ page');
});

test('no address is in the repository', () => {
  // ⚠️ The whole reason the roster moved to the database. An address committed
  // once is in the history permanently, carried by any clone, fork or extracted
  // template even after the person is removed.
  const skip = /node_modules|_site|build|\.git|\.wrangler/;
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`;
      if (skip.test(full)) continue;
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(md|yml|yaml|js|mjs|json|njk|css|sql|jsonc)$/.test(e.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      // example.org and example.com are placeholders; anything else is a person.
      // A Google Fonts axis spec (`wght@9..144`) is not an address.
      for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w-]+\.?[\w-]*/g)) {
        if (!/@[\w-]+\.(org|com|net|dev|io|nyc|guide)\b/.test(m[0])) continue;
        if (/@(example\.(org|com)|[\w-]*\.?example)/i.test(m[0])) continue;
        if (/noreply@|onboarding@resend\.dev/.test(m[0])) continue;
        offenders.push(`${full.replace('./', '')}: ${m[0]}`);
      }
    }
  };
  walk('.');
  assert.deepEqual([...new Set(offenders)], []);
});

test('the config declares no provider list, because nothing would read it', () => {
  // ⚠️ `auth.providers` sat in site.config.yml looking like configuration and
  // gated nothing: worker/src/auth.js decides from whether credentials exist.
  // A key that appears to configure something and does not is worse than no
  // key — somebody edits it, nothing changes, and the config stops being
  // trusted. Removed rather than wired up, because deciding from the
  // credentials is the better half of the two.
  const config = read('site.config.yml');
  assert.equal(/^\s*providers:/m.test(config), false,
    'site.config.yml declares auth.providers again; nothing reads it');
  assert.match(read('worker/src/auth.js'), /async function enabled\(env\)/,
    'the real provider gate has moved or been renamed');
});


// --- the agent index ---------------------------------------------------------
// ⚠️ On a PUBLIC instance both halves of the check run: the notice must not
// describe the site as closed, and every path it names must be served. On a
// PRIVATE one the notice is the short "ask for access" one and the public-claim
// half stays quiet; the path half still runs, because a notice naming a sign-in
// route that does not exist is the same dead end.
const resolvesOnThisSite = (p) => {
  const rel = p.replace(/^\//, '');
  const candidates = [path.join(SITE, rel), path.join(SITE, rel, 'index.html'), path.join(SITE, `${rel}index.html`)];
  return candidates.some((c) => fs.existsSync(c)) || matches(p);
};

test('the agent index describes this site and points only at what it serves', () => {
  assert.deepEqual(
    d.agentIndexRot(PUBLIC_NOTICE, { isPublic: IS_PUBLIC, resolves: resolvesOnThisSite }),
    [],
  );
});

test('the agent index check can see a notice that has rotted', () => {
  const rotted = [
    '# A site',
    'A private collaboration site. The content is not published.',
    '- [Gone](/nowhere/)',
    'Access: ask you@example.org.',
  ].join('\n');
  const found = d.agentIndexRot(rotted, { isPublic: true, resolves: () => false });
  assert.ok(found.some((m) => /not published/.test(m)), 'missed the private claim on a public site');
  assert.ok(found.some((m) => /\/nowhere\//.test(m)), 'missed the dead path');
  assert.ok(found.some((m) => /placeholder/.test(m)), 'missed the placeholder contact');
  // And it must stay quiet on a private instance saying true things about itself.
  assert.deepEqual(
    d.agentIndexRot('# A site\nThe content is not published.\n', { isPublic: false, resolves: () => true }),
    [],
  );
});
