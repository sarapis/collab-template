// Pure detectors. Each one is exercised twice in gate.test.js: against the real
// site, where it must stay quiet, and against a crafted violation, where it
// must speak.
//
// ⚠️ A structural checker that silently matches nothing passes forever and is
// worse than no checker. Every detector here has a self-test for that reason,
// and the convention is not optional.

export function anchorsIn(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

// Anchor hrefs only. A stylesheet or an icon is a resource, not a link to a
// page, and treating one as the other makes the check cry wolf until somebody
// deletes it.
export function linksIn(html) {
  return [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]);
}

/** In-page links (#foo) must resolve inside the page that makes them. */
export function danglingInPageAnchors(pages) {
  const out = [];
  for (const p of pages) {
    const ids = anchorsIn(p.html);
    for (const href of linksIn(p.html)) {
      if (!href.startsWith('#')) continue;
      const target = decodeURIComponent(href.slice(1));
      if (target && !ids.has(target)) out.push(`${p.path}: #${target} resolves to nothing`);
    }
  }
  return out;
}

/**
 * Cross-document links must land on a built page or on a route the Worker
 * declares, and on the page's anchor if one is named.
 *
 * ⚠️ Both halves matter. A link to a built page that does not exist is dead; so
 * is a link to /auth/logout if the Worker never routed it. Checking only pages
 * made the sign-out link look broken; checking only routes would miss every
 * dead document link.
 */
export function danglingCrossLinks(pages, isRoute = () => false) {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const out = [];
  for (const p of pages) {
    for (const href of linksIn(p.html)) {
      if (!href.startsWith('/') || href.startsWith('//')) continue;
      const [withoutFrag, frag] = href.split('#');
      const rawPath = withoutFrag.split('?')[0];
      const path = rawPath.endsWith('/') ? `${rawPath}index.html` : rawPath;
      const target = byPath.get(path);
      if (!target) {
        if (isRoute(rawPath)) continue;
        out.push(`${p.path}: ${href} points at no page and no route`);
        continue;
      }
      if (frag && !anchorsIn(target.html).has(decodeURIComponent(frag))) {
        out.push(`${p.path}: ${href} names an anchor ${path} does not declare`);
      }
    }
  }
  return out;
}

/** Every class a page uses must be styled somewhere. */
export function unstyledClasses(pages, css, ignore = []) {
  const styled = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  // `language-*` comes from the markdown renderer and is styled through an
  // attribute selector (`code[class^="language-"]`), which this check cannot
  // see. Listing every language instead would fail the build the first time
  // somebody wrote a code fence in a new language, which is not a defect.
  const attributeStyled = (cls) => /^language-/.test(cls);
  const out = [];
  for (const p of pages) {
    for (const m of p.html.matchAll(/\sclass="([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/).filter(Boolean)) {
        if (!styled.has(cls) && !ignore.includes(cls) && !attributeStyled(cls)) {
          out.push(`${p.path}: class "${cls}" is used and never styled`);
        }
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Every token defined for light must be defined for dark.
 * ⚠️ A token the dark block does not redefine keeps its LIGHT value while --ink
 * flips, which is light-on-light. Four ops pages carried an unreadable amber
 * callout for a month because the warn family mapped six decorated aliases and
 * missed --warn-soft, the plain name the pages actually used.
 */
export function tokenParity(css) {
  const block = (sel) => (css.split(sel)[1] || '').split('}')[0];
  const names = (src) => new Set([...src.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const light = names(block(':root {'));
  const dark = names(block(':root[data-theme="dark"]'));
  const media = names(block(':root:not([data-theme="light"])'));
  const structural = /^--(radius|measure|font)/;
  return [...light].filter((t) => !structural.test(t) && !(dark.has(t) && media.has(t)))
    .map((t) => `${t} is defined for light and not for both dark selectors`);
}

/** Every /api/ path a script calls must exist on the server. */
export function unresolvedApiCalls(js, matches) {
  const calls = [...js.matchAll(/['"`](\/api\/[^'"`?\s]*)/g)].map((m) => m[1]);
  return [...new Set(calls)]
    .filter((path) => !matches(path.replace(/\/[^/]*$/, (s) => (/^\/\$|\{/.test(s) ? '/:id' : s))) && !matches(path))
    .map((path) => `page calls ${path}, which the server does not route`);
}

/** Every h2 in a document must be reachable from its contents list. */
// The contents list is found by its class, not by its position in the document.
// Locating it by "everything before <main>" broke the moment the rail moved to
// the right of the content, and the check would have gone quiet rather than
// failing -- which is the failure mode this whole file exists to prevent.
export function unreachableSections(page) {
  const toc = (page.html.match(/<nav class="toc"[\s\S]*?<\/nav>/) || [''])[0];
  const main = (page.html.split('<main>')[1] || '').split('</main>')[0];
  const listed = new Set([...toc.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]));
  return [...main.matchAll(/<h2 id="([^"]+)"/g)]
    .map((m) => m[1]).filter((id) => !listed.has(id))
    .map((id) => `${page.path}: section #${id} is not in the contents list`);
}

/** Long unbroken tokens in code must be able to wrap. */
export function codeCannotWrap(css) {
  return /main code\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css)
    ? [] : ['code does not wrap: one unbreakable path scrolls the whole page sideways on mobile'];
}

/** One catalog, no copy: a document's asides must equal the catalog's view. */
export function catalogCopies(pages, manifest) {
  const out = [];
  for (const doc of manifest.docs) {
    const path = `/${doc.slug}/index.html`;
    const page = pages.find((p) => p.path === path);
    if (!page) continue;
    const rendered = [...page.html.matchAll(/data-question="([^"]+)"/g)].map((m) => m[1]);
    const expected = manifest.questions.filter((q) => q.doc === doc.slug && q.margin).map((q) => q.id);
    const extra = rendered.filter((id) => !expected.includes(id));
    const missing = expected.filter((id) => !rendered.includes(id));
    for (const id of extra) out.push(`${path}: renders ${id}, which the catalog does not place here`);
    for (const id of missing) out.push(`${path}: the catalog places ${id} here and the page does not render it`);
  }
  return out;
}

/** Counts stated in prose must be computed, never typed. */
export function typedCounts(templates) {
  const out = [];
  for (const t of templates) {
    for (const m of t.src.matchAll(/(\d+)\s+(questions?|documents?|open|resolved|total)\b/gi)) {
      out.push(`${t.path}: "${m[0]}" is a typed count; compute it`);
    }
  }
  return out;
}

/** The manifest must be internally consistent with the config. */
export function manifestIntegrity(manifest) {
  const out = [];
  const audiences = new Set(Object.keys(manifest.audiences || {}));
  const rounds = new Set(Object.keys(manifest.asked_rounds || {}));
  const anchors = new Set();
  for (const d of manifest.docs) for (const h of d.headings) if (h.id) anchors.add(`${d.slug}#${h.id}`);
  const seen = new Set();
  for (const q of manifest.questions) {
    if (!audiences.has(q.audience)) out.push(`Q${q.number}: audience "${q.audience}" is not declared`);
    if (!rounds.has(q.asked)) out.push(`Q${q.number}: asked round "${q.asked}" is not declared`);
    if (q.margin && !anchors.has(`${q.doc}#${q.section}`)) out.push(`Q${q.number}: section anchor ${q.doc}#${q.section} does not exist`);
    if (seen.has(q.number)) out.push(`Q${q.number} is used twice`);
    seen.add(q.number);
    if (q.resolved) {
      const ref = q.resolved.startsWith('#') ? `${q.doc}${q.resolved}` : q.resolved;
      if (!anchors.has(ref)) out.push(`Q${q.number}: resolved against ${q.resolved}, which is not an anchor`);
    }
  }
  return out;
}

/**
 * No page may appear twice in the left menu.
 * ⚠️ This exists because Nunjucks silently ignored two different filtering
 * constructs, and each time the symptom was a page listed in two groups -- a
 * wrong menu that looked like somebody's decision. A duplicate is the visible
 * edge of an invisible filter failure.
 */
export function duplicateMenuLinks(page) {
  // ⚠️ The sidebar FOOT counts as the sidebar. Looking only inside <nav> let
  // Notifications appear in both the Overview group and the foot, which is the
  // same "two places to click for one thing" this check exists to catch.
  const menu = (page.html.match(/<nav class="menu">[\s\S]*?<\/nav>/) || [''])[0]
    + (page.html.match(/<div class="sidebar-foot">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  const hrefs = [...menu.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set(), dupes = new Set();
  for (const h of hrefs) (seen.has(h) ? dupes : seen).add(h);
  return [...dupes].map((h) => `${page.path}: the menu lists ${h} twice`);
}

/**
 * A quote is a measurement of somebody's words.
 *
 * ⚠️ This exists because a published quote turned out to be a PREFIX of an
 * answer with a full stop supplied, and the half it cut was a requirement. An
 * excerpt is legitimate and must say so with data-answer-excerpt; anything else
 * must match the stored text exactly.
 */
export function driftedQuotes(quotes, exported) {
  const out = [];
  // ⚠️ Compare what a READER sees, not what the source bytes are. Markdown turns
  // a line break inside the quote into one in the HTML, so a quote wrapped to
  // fit the column is the same words on the page and different bytes here --
  // and an answer that was itself typed over several lines could not be quoted
  // in full AT ALL, which pushes a contributor towards retyping it. Collapsing
  // runs of whitespace cannot let a wrong quote through: every word still has to
  // be there, in order, and a prefix is still a prefix.
  const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
  for (const q of quotes || []) {
    const stored = exported?.answers?.[q.slug];
    if (!stored || !stored.length) { out.push(`"${q.slug}" is quoted in ${q.doc} and no answer to it is exported`); continue; }
    const bodies = stored.map((a) => flat(a.body));
    const text = flat(q.text);
    const hit = q.excerpt ? bodies.some((b) => b.includes(text)) : bodies.some((b) => b === text);
    if (!hit) {
      out.push(`${q.doc} quotes "${q.slug}" as ${JSON.stringify(text.slice(0, 60))}, which is not what the answer says`);
    }
  }
  return out;
}

/**
 * A page behind a permission must say so when you do not have it.
 *
 * ⚠️ Every admin screen renders for anyone — hiding a section is presentation,
 * not access control, and the server refuses regardless. So the visitor who is
 * refused sees a heading and blank space, which reads as broken rather than as
 * not-for-you. This is the "empty UI states read as broken" finding from the
 * site review, in this project's own product.
 *
 * Caught exactly this twice: a settings page shipped with no denied state, and
 * the conversation log had never had one.
 */
export function adminPagesExplainThemselves(pages, widgetSource) {
  const out = [];
  for (const p of pages) {
    if (!p.path.startsWith('/admin/')) continue;
    const ids = [...p.html.matchAll(/id="([a-z0-9-]+-denied)"/g)].map((m) => m[1]);
    if (!ids.length) {
      out.push(`${p.path}: nothing explains itself to a visitor who is refused — add an id ending -denied`);
      continue;
    }
    for (const id of ids) {
      if (!widgetSource.includes(`'${id}'`)) {
        out.push(`${p.path}: ${id} exists and the widget never shows it, so it is hidden forever`);
      }
    }
  }
  return out;
}

/**
 * An instance must never point at another instance's resources.
 *
 * ⚠️ This is the worst thing a fork can do, and it fails silently in the most
 * dangerous direction: one Worker reads and WRITES another project's live
 * database, under a different roster, and everything looks like it is working.
 *
 * It nearly happened when a second instance was built from this machinery. A KV
 * namespace title is unique per account, so `wrangler kv namespace create
 * OAUTH_KV` failed — the other instance already had one — and the obvious fix is
 * to reuse the id that came back from `list`. That would have put both sites'
 * OAuth clients, grants and tokens in one store.
 */
export function foreignResources(wranglerSource, otherInstanceIds) {
  return (otherInstanceIds || [])
    .filter((id) => id && wranglerSource.includes(id))
    .map((id) => `wrangler.jsonc names ${id}, which belongs to a different instance of this machinery`);
}

/**
 * A figure in prose is a measurement, and must match what was measured.
 *
 * ⚠️ "Never type a count" was only ever enforced for counts about the SITE —
 * questions, documents, open, resolved. Every domain number in the prose was
 * unguarded, which is the larger surface by far: a figure that was true when it
 * was typed is the most ordinary way a document goes quietly wrong, and this
 * project's own thesis is that a confident number is exactly what nobody
 * re-checks.
 *
 * ⚠️ Thousands separators are normalised, because 6,025 and 6025 are the same
 * measurement and a document should be free to be readable. Nothing else is:
 * a different number is a different number.
 */
export function driftedFigures(figures, exported) {
  const out = [];
  const known = exported?.figures || {};
  const norm = (v) => String(v).replace(/[,\s\u00a0_]/g, '');
  for (const f of figures || []) {
    if (!(f.key in known)) {
      out.push(`${f.doc} states a figure "${f.key}", which nothing computes — add it to scripts/export-figures.mjs or the number is unguarded`);
      continue;
    }
    if (norm(f.text) !== norm(known[f.key])) {
      out.push(`${f.doc} says ${JSON.stringify(f.text)} for "${f.key}" and the measurement is ${JSON.stringify(String(known[f.key]))}`);
    }
  }
  return out;
}

/**
 * A private instance must run the Worker before the asset server.
 *
 * ⚠️ This is the most dangerous bug found while building this, and no test in
 * this file could have caught it: with `run_worker_first` unset, Cloudflare's
 * asset server answers any request matching a file in the output directory
 * BEFORE the Worker runs. Every page of a private site was served to anyone who
 * asked, while /api/ stayed correctly locked -- so the site worked, the auth
 * code was correct, and it was simply never called.
 */
export function assetsBypassAuth(wranglerSource) {
  const stripped = wranglerSource.replace(/^\s*\/\/.*$/gm, '');
  let config;
  try { config = JSON.parse(stripped); } catch (e) { return [`wrangler.jsonc does not parse: ${e.message}`]; }
  const publicRead = String(config.vars?.PUBLIC_READ) === 'true';
  const workerFirst = config.assets?.run_worker_first === true;
  if (!publicRead && config.assets && !workerFirst) {
    return ['PUBLIC_READ is false but assets.run_worker_first is not true: every page would be served without an auth check'];
  }
  return [];
}

/** A deployed instance must never carry the development sign-in switch. */
export function devSignInDeployed(wranglerSource) {
  const stripped = wranglerSource.replace(/^\s*\/\/.*$/gm, '');
  let config;
  try { config = JSON.parse(stripped); } catch { return []; }
  return String(config.vars?.DEV_SIGN_IN) === 'true'
    ? ['DEV_SIGN_IN is true in wrangler.jsonc: anyone could name themselves in a cookie'] : [];
}

/** A committed config must not print sign-in links to the log. */
export function magicLinksInLog(wranglerSource) {
  const stripped = wranglerSource.replace(/^\s*\/\/.*$/gm, '');
  let config;
  try { config = JSON.parse(stripped); } catch { return []; }
  return String(config.vars?.MAGIC_LINK_TO_LOG) === 'true'
    ? ['MAGIC_LINK_TO_LOG is true in wrangler.jsonc: anyone with log access can sign in as anyone'] : [];
}

/**
 * The generated roster must equal the one in site.config.yml.
 * ⚠️ Two lists of who may sign in is the failure this project keeps naming: the
 * ops site's login list was justified as mirroring another list, stopped
 * mirroring it, and became a judgement call with no source behind it.
 */
export function rosterDrift(configRoster, generatedSource) {
  const m = generatedSource.match(/export const ROSTER = (\{[\s\S]*?\n\});/);
  if (!m) return ['worker/src/roster.generated.js does not export a roster'];
  let generated;
  try { generated = JSON.parse(m[1]); } catch (e) { return [`the generated roster does not parse: ${e.message}`]; }
  const a = JSON.stringify(configRoster || {});
  const b = JSON.stringify(generated);
  return a === b ? [] : ['worker/src/roster.generated.js is out of date with site.config.yml; run the build and commit it'];
}

/** Nobody's address may appear in anything the site serves. */
export function addressesInBuiltSite(configRoster, servedText) {
  const out = [];
  for (const [key, person] of Object.entries(configRoster || {})) {
    if (person.email && servedText.includes(person.email)) {
      out.push(`the built site carries ${key}'s email address; the roster must not be served`);
    }
  }
  return out;
}

/**
 * Every token a stylesheet USES must be one the design system defines.
 * ⚠️ A misspelled custom property is not an error anywhere: the declaration is
 * simply dropped and the element renders with no colour at all, or inherits one
 * that happens to look plausible. Renaming the palette onto the Sarapis names
 * is exactly when this bites.
 */
export function undefinedTokens(usageCss, tokensCss) {
  const defined = new Set([...tokensCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set();
  for (const m of usageCss.matchAll(/var\((--[\w-]+)/g)) used.add(m[1]);
  return [...used].filter((t) => !defined.has(t)).map((t) => `${t} is used and the design system does not define it`);
}

/**
 * Exactly one menu item is marked current on every page.
 * ⚠️ Before the menu was driven from one list, only a document could be
 * current — so Questions, Activity and Design showed nothing selected, on the
 * pages people spend the most time on. Zero is the bug; two would be worse.
 */
export function menuCurrentState(pages) {
  const out = [];
  for (const p of pages) {
    const menu = (p.html.match(/<nav class="menu">[\s\S]*?<\/nav>/) || [''])[0];
    if (!menu) continue;
    const n = (menu.match(/aria-current="page"/g) || []).length;
    if (n > 1) { out.push(`${p.path}: ${n} menu items marked current, expected at most 1`); continue; }
    // A page that IS in the menu must be marked; a permalink that is not in the
    // menu -- an activity entry, a decision -- correctly marks nothing.
    const url = p.path.replace(/index\.html$/, '');
    const hrefs = [...menu.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    if (hrefs.includes(url) && n !== 1) out.push(`${p.path}: it is in the menu and nothing is marked current`);
  }
  return out;
}

/**
 * Nothing may be published that the build did not just produce.
 * ⚠️ Eleventy does not delete the output of a page that no longer exists, and
 * the Worker serves the whole directory — so a document removed from the repo
 * stayed live, with its old content, and only an auth wall kept it private.
 */
export function orphanedPages(pages, manifest, templatePaths) {
  const known = new Set(templatePaths);
  for (const doc of manifest.docs) {
    known.add(`/${doc.slug}/index.html`);
  }
  return pages.map((p) => p.path).filter((path) => !known.has(path))
    .map((path) => `${path} is published and nothing in this build produces it`);
}

/**
 * A partial must not also be published at a URL of its own.
 * ⚠️ Its prose is included by a template. If it were also paginated into a page,
 * the same words would exist at two addresses — and the one nobody links to is
 * the one that goes stale without anybody noticing.
 */
export function partialsPublished(pages, manifest, templatePaths) {
  const templates = new Set(templatePaths);
  return (manifest.docs || []).filter((d) => d.partial)
    .map((d) => `/${d.slug}/index.html`)
    .filter((path) => pages.some((p) => p.path === path) && !templates.has(path))
    .map((path) => `${path} is a partial and is also published as its own page`);
}

/**
 * Having content must not look like being the current page.
 * ⚠️ The notifications item used the same accent background for "has unread"
 * as the sidebar uses for aria-current, so it appeared selected from every page
 * that had any notifications. A state that borrows the styling of a different
 * state is a lie the CSS tells consistently.
 */
export function stateStylingCollision(css, stateSelector, currentSelector) {
  const rule = (sel) => {
    const i = css.indexOf(sel);
    if (i === -1) return null;
    const open = css.indexOf('{', i);
    return css.slice(open + 1, css.indexOf('}', open));
  };
  const a = rule(stateSelector);
  const b = rule(currentSelector);
  if (!a || !b) return [];
  const bg = (body) => (body.match(/background:\s*([^;]+)/) || [])[1]?.trim();
  return bg(a) && bg(a) === bg(b)
    ? [`${stateSelector} and ${currentSelector} share a background, so the two states look identical`]
    : [];
}

/**
 * A list of questions that are not questions.
 *
 * ⚠️ The first document written by the second collaborator carried five open
 * questions as a bulleted list. They were good questions, clearly addressed to
 * somebody — and none had a number, reached a notification, or could ever be
 * answered or resolved, because none was a `:::question`. That is the mechanism
 * this project is built on going unused by the first person to use it.
 *
 * Writing a bulleted list is what you do in a markdown document. Nothing put the
 * alternative in front of her at the moment she was writing questions, so this
 * does — at build time, by name.
 */
export function questionsWrittenAsProse(sources, manifest) {
  const out = [];
  for (const { slug, text } of sources) {
    const heading = text.match(/^##+\s+.*\b(open questions?|questions for|things to (ask|decide))\b.*$/im);
    if (!heading) continue;
    const after = text.slice(text.indexOf(heading[0]) + heading[0].length);
    const bullets = (after.match(/^\s*[-*]\s+\S/gm) || []).length;
    if (!bullets) continue;
    const declared = (manifest.questions || []).filter((q) => q.doc === slug).length;
    if (!declared) {
      out.push(`${slug}: "${heading[0].trim()}" lists ${bullets} bullet(s) and the document declares no :::question — they will never be numbered, notified, answered or resolved`);
    }
  }
  return out;
}

/**
 * The agent index (`/llms.txt`) must describe THIS site and point only at
 * things it serves.
 *
 * ⚠️ Both halves of this were live at once on a public instance. The notice was
 * inherited unchanged from a private one, so a site whose entire purpose is that
 * its findings are citable told every reader "the content is not published,
 * reading it requires a sign-in" — and then sent them to a repository instead of
 * the URL that had the answers. Nothing caught it because nothing read the file.
 *
 * A stale agent index is worse than none. A missing one leaves an assistant to
 * crawl and find the truth; a confident wrong one stops it looking.
 *
 * `resolves(path)` is supplied by the caller: a built page, a served file, a
 * directory, or a route the Worker declares.
 */
export function agentIndexRot(notice, { isPublic, resolves }) {
  if (!notice) return [];
  const out = [];

  // ⚠️ A public instance must not describe itself as closed. Checked by what it
  // CLAIMS rather than by comparing against a known string, so rewording the
  // notice cannot quietly turn the check off.
  if (isPublic) {
    for (const [re, what] of [
      [/\bnot published\b/i, 'says its content is not published'],
      [/requires a sign-?in/i, 'says reading requires a sign-in'],
      [/\bprivate collaboration site\b/i, 'calls itself private'],
      [/this URL is not\b/i, 'tells an assistant to go somewhere else'],
    ]) if (re.test(notice)) out.push(`/llms.txt ${what}, and this instance is public`);
  }

  // Every path it names, in any of the three shapes a notice writes them:
  // a markdown link, a bare path in a list, a path at the end of a sentence.
  const paths = new Set();
  for (const m of notice.matchAll(/\]\((\/[^)\s]*)\)/g)) paths.add(m[1]);
  for (const m of notice.matchAll(/(?:^|\s)(\/[A-Za-z0-9._\-/]*)/g)) paths.add(m[1]);
  for (const p of paths) {
    const clean = p.replace(/[.,;:]$/, '');
    if (!clean || clean === '/') continue;
    if (!resolves(clean)) out.push(`/llms.txt points at ${clean}, which this site does not serve`);
  }

  // ⚠️ A placeholder is worse than an omitted line: it reads as a route in.
  if (/example\.(org|com)|you@|TODO|FIXME/i.test(notice)) {
    out.push('/llms.txt carries a placeholder contact, which looks like a way in and is not');
  }
  return out;
}

/**
 * A passthrough page must not claim an address the site already serves.
 *
 * ⚠️ `site.passthrough` is the one place an instance can put a file at an
 * arbitrary address, and it is copied in AFTER everything else is built. A
 * `to` of `artifact/index.html` on a site that also has a document `artifact`
 * is two things at one URL, and which of them a reader gets is decided by the
 * layout rather than by anything anybody wrote down: in the classic layout the
 * copy lands on top of the compiled page, so the artifact wins and the
 * document is gone; in the band layout the Worker renders the document from
 * the live version and never reaches ASSETS, so the artifact is the one that
 * is gone. Either way nothing fails — a page is served at that address, it is
 * simply the other one — and the gate's own layout checks skip it, because
 * `site.passthrough` is exactly the list of addresses they are told to skip.
 * So the hole this opens is in the checks as well as in the site.
 *
 * `served` is a Map of address → what already serves it, supplied by the
 * caller: the documents and the pages this template builds.
 */
export function passthroughCollisions(passthrough, served) {
  const out = [];
  const mine = new Map();
  for (const entry of passthrough || []) {
    const from = String(entry?.from || '');
    const to = String(entry?.to || '');
    if (!from || !to) {
      out.push(`site.passthrough has an entry without ${from ? 'a to' : 'a from'}`);
      continue;
    }
    // The address Eleventy will serve it at. A `to` naming a directory keeps
    // the source file's own name; `index.html` is the directory itself.
    let at = '/' + to.replace(/^\/+/, '');
    if (at.endsWith('/')) at += from.split('/').pop();
    at = at.replace(/(^|\/)index\.html$/, '$1');
    const taken = served.get(at) || mine.get(at);
    if (taken) out.push(`site.passthrough serves ${from} at ${at}, which is already ${taken}`);
    else mine.set(at, `the passthrough page ${to}`);
  }
  return out;
}
