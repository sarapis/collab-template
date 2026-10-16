import yaml from 'js-yaml';
import MarkdownIt from 'markdown-it';
import { headingIds } from './headings.js';
import { questionContainer, collectQuestions, splitWhy } from './questions.js';
import { reconcileLock, serializeLock } from './lock.js';

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function makeMarkdown() {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  headingIds(md);
  questionContainer(md, {});
  return md;
}

function splitFront(raw) {
  const m = raw.match(FRONT);
  if (!m) return { data: {}, body: raw };
  return { data: yaml.load(m[1]) || {}, body: raw.slice(m[0].length) };
}

// `to="platform-team, devin"` -> ['platform-team', 'devin']: commas or spaces.
export function addressList(raw) {
  return String(raw).split(/[\s,]+/).filter(Boolean);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The question renders as STATIC HTML in the document.
//
// GMTools injects the whole note from JavaScript, so with the API down the
// reader sees no question at all. Here the question is content -- it comes from
// the repo -- so it ships in the HTML and the widget only ADDS the answers and
// the form. A document with no JavaScript and no network still shows every
// question it is hedging on, which is the honest state of the document.
function renderAside(q, addressees) {
  const cls = ['q', q.resolved ? 'q-resolved' : 'q-open'].join(' ');
  const num = `<a class="q-num" href="/questions/#q${q.number}">Q${q.number}</a>`;
  const to = q.to
    ? ` <span class="q-to">to ${q.to.map((k) => esc(addressees?.[k]?.name || k)).join(', ')}</span>`
    : '';
  const meta = `<span class="q-audience">${esc(q.audience)}</span>${to}`;
  const resolved = q.resolved
    ? `<p class="q-resolved-note">resolved · see <a href="${esc(q.resolved)}">this passage</a></p>`
    : '';
  const why = q.why ? `<div class="q-why"><strong>Why asked:</strong>${q.why}</div>` : '';
  const see = (q.see || []).length
    ? `<p class="q-see">Context: ${q.see.map((r) => (r.kind === 'section'
        ? `<a href="/${esc(r.doc)}/#${esc(r.section)}" data-see-section="${esc(r.doc)}#${esc(r.section)}">${esc(r.title || r.section)}</a>`
        : `<a href="${esc(r.url)}" rel="noreferrer" target="_blank">${esc(r.label)} \u2197</a>`)).join(' · ')}</p>`
    : '';
  return [
    `<aside class="${cls}" id="q${q.number}" data-question="${esc(q.id)}" data-number="${q.number}" data-audience="${esc(q.audience)}"${q.to ? ` data-to="${esc(q.to.join(' '))}"` : ''}>`,
    `<header class="q-head">${num} ${meta}</header>`,
    `<div class="q-body">${q.body}</div>`,
    why,
    see,
    resolved,
    `<div class="q-answers" data-answers-for="${esc(q.id)}"></div>`,
    `</aside>`,
  ].join('');
}

// ⚠️ A DATE IS A CALENDAR DAY, written YYYY-MM-DD. js-yaml reads an unquoted
// `date: 2026-09-17` as a Date at midnight UTC, and `String(date).slice(0, 10)`
// formatted it in the BUILD MACHINE'S time zone: "Wed Sep 16" on a Mac in New
// York, "Thu Sep 17" on a UTC runner. Every decision and activity page on both
// instances showed the first, a day early, until 2026-10-11. Format in UTC.
export function isoDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// The compiler over an in-memory project: `files` maps a path under the project
// root ('site.config.yml', 'README.md', 'content/<slug>.md',
// 'content/questions.lock') to its text. No file system, so a host with none (a
// Worker rebuilding on save) runs the same code as the CLI; `compile()` in
// index.js reads a directory into this shape and calls it.
//
// `display` names a file in an error message (the CLI passes its full path).
export function compileFiles({ files, contentDir = 'content', configFile = 'site.config.yml', lockFile = 'content/questions.lock', display = (p) => p } = {}) {
  const errors = [], warnings = [];
  const config = yaml.load(files[configFile] ?? '') || {};
  const audiences = new Set(Object.keys(config.audiences || {}));
  // ADDRESSING, apart from the audience: `to="a, b"` names who a
  // question is waiting on, each one declared under `addressees`. Optional, and
  // absent from the output when unused, so a project that never addresses a
  // question compiles byte-identical to the version before addressing. An undeclared name is an error,
  // never a silent "waiting on nobody" (the typo v1.9.0 fixed for groups).
  const addressees = config.addressees || null;

  const existingLock = files[lockFile] != null ? JSON.parse(files[lockFile]) : null;

  // ⚠️ A round with no `opened` date fails rather than defaulting. Defaulting to
  // the epoch would make every prior answer count as current, so rewording a
  // question would silently leave it answered -- the exact failure the date
  // exists to prevent, and invisible because nothing would look wrong.
  const rounds = {};
  for (const [name, r] of Object.entries(config.asked_rounds || {})) {
    if (!r || !r.opened) {
      errors.push(`asked round "${name}" declares no \`opened\` date, so an answer written before it cannot be told from one written after`);
      continue;
    }
    const at = new Date(r.opened);
    if (Number.isNaN(at.getTime())) {
      errors.push(`asked round "${name}" has an \`opened\` value that is not a date: ${r.opened}`);
      continue;
    }
    rounds[name] = { ...r, opened: at.toISOString() };
  }

  const md = makeMarkdown();
  // Sorted by path, as a recursive directory walk sorted at every level is.
  const prefix = `${contentDir}/`;
  const paths = Object.keys(files).filter((p) => p.startsWith(prefix) && p.endsWith('.md')).sort();
  const docs = [], raw = [];

  // ⚠️ README.md is compiled as the orientation page, not copied to one. GitHub
  // renders it and so does this site, from the same bytes -- a contributor who
  // clones the repo and a reader who opens the URL are looking at one document.
  // A second copy of "what this project is" is the drift nobody notices until
  // the two disagree about something that matters.
  //
  // ⚠️ Its slug is `start`, not `index`, because `/` is a ROUTER and not a page:
  // it sends a first-time reader to /start/ and everybody else to /summary/.
  // Naming this document `index` made three separate places special-case the
  // word to turn it back into `/`.
  if (files['README.md'] != null) paths.unshift('README.md');

  for (const p of paths) {
    const isReadme = p === 'README.md';
    const file = display(p);
    const rel = isReadme ? 'README.md' : p.slice(prefix.length);
    const slug = isReadme ? 'start' : rel.replace(/\.md$/, '').replace(/\/index$/, '');
    const { data, body } = splitFront(files[p]);
    if (isReadme) { data.menu = 'project'; data.nav = data.nav ?? 0; data.title = data.title || config.project?.name; }
    const tokens = md.parse(body, {});

    const headings = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'heading_open') continue;
      headings.push({
        level: Number(tokens[i].tag.slice(1)),
        id: tokens[i].meta?.id || tokens[i].attrGet('id'),
        text: (tokens[i + 1]?.content || '').trim(),
        explicit: !!tokens[i].meta?.explicit,
      });
    }

    const qs = collectQuestions(tokens, slug);
    docs.push({ slug, file, rel, title: data.title || headings[0]?.text || slug, nav: data.nav ?? 100, nav_id: data.nav_id || slug,
      type: data.type || 'doc', menu: data.menu || null,
      // A partial is compiled and served as a fragment but gets no page of its
      // own: a template includes it. That is how prose stays editable in
      // markdown on a page whose figures have to be computed.
      partial: data.partial === true,
      date: isoDate(data.date), author: data.author || null,
      headings, tokens, questions: qs });
    raw.push(...qs.map((q) => ({ ...q, docSlug: slug, file })));
  }

  // --- validate before numbering: a bad catalog must not mint numbers -------
  const bySlug = new Map();
  for (const q of raw) {
    const where = `${q.file}:${q.line}`;
    const slug = q.attrs.slug;
    if (!slug) { errors.push(`${where}: question has no slug`); continue; }
    if (bySlug.has(slug)) { errors.push(`${where}: duplicate question slug "${slug}" (also ${bySlug.get(slug).file})`); continue; }
    bySlug.set(slug, q);

    if (!q.attrs.audience) errors.push(`${where}: question "${slug}" names no audience`);
    else if (audiences.size && !audiences.has(q.attrs.audience)) errors.push(`${where}: question "${slug}" names audience "${q.attrs.audience}", which site.config.yml does not declare`);

    if (q.attrs.to !== undefined) {
      const to = addressList(q.attrs.to);
      if (!to.length) errors.push(`${where}: question "${slug}" has an empty to=`);
      else if (!addressees) errors.push(`${where}: question "${slug}" is addressed (to=), but site.config.yml declares no addressees`);
      for (const name of to) {
        if (addressees && !Object.hasOwn(addressees, name)) errors.push(`${where}: question "${slug}" is addressed to "${name}", which site.config.yml does not declare under addressees`);
      }
      if (new Set(to).size !== to.length) errors.push(`${where}: question "${slug}" names an addressee twice`);
    }

    // A missing round FAILS rather than defaulting. Defaulting would file a new
    // round under "you have already seen these", and nothing would look wrong.
    if (!q.attrs.asked) errors.push(`${where}: question "${slug}" declares no asked round`);
    else if (Object.keys(rounds).length && !rounds[q.attrs.asked]) errors.push(`${where}: question "${slug}" names asked round "${q.attrs.asked}", which site.config.yml does not declare`);

    if (q.attrs.margin !== 'false' && !q.section) errors.push(`${where}: question "${slug}" sits under no heading, so it has no section to render beside`);
  }

  if (errors.length) return { ok: false, errors, warnings, manifest: null, fragments: {}, lock: existingLock };

  const slugs = raw.map((q) => q.attrs.slug);
  const { lock, assigned, retiredNow } = reconcileLock(existingLock, slugs);

  // --- render --------------------------------------------------------------
  // ⚠️ Anchors are gathered BEFORE rendering, because a question's references
  // are resolved while its note is built. Resolving them afterwards rendered
  // every note without its context and said nothing.
  const anchors = new Set();
  const headingText = new Map();
  for (const doc of docs) {
    for (const h of doc.headings) {
      if (!h.id) continue;
      anchors.add(`${doc.slug}#${h.id}`);
      headingText.set(`${doc.slug}#${h.id}`, h.text);
    }
  }

  // `see=` lets a question point at the passage it depends on, and at things
  // outside this repo. ⚠️ Both are checked: an internal anchor must exist and an
  // external name must be declared in site.config.yml. A reference that quietly
  // stops resolving is the same failure as an anchor naming nothing — the
  // question still lists, and only the context disappears.
  const references = config.references || {};
  const resolveSee = (raw, slug, docSlug) =>
    String(raw || '').split(',').map((x) => x.trim()).filter(Boolean).map((ref) => {
      if (ref.startsWith('#') || ref.includes('#')) {
        const [d, section] = ref.startsWith('#') ? [docSlug, ref.slice(1)] : ref.split('#');
        const key = `${d}#${section}`;
        if (!anchors.has(key)) {
          errors.push(`question "${slug}" cites ${key}, which no document declares`);
          return null;
        }
        return { kind: 'section', doc: d, section, title: headingText.get(key) || section };
      }
      if (references[ref]) {
        return { kind: 'external', name: ref, url: references[ref].url, label: references[ref].label || ref };
      }
      errors.push(`question "${slug}" cites "${ref}", which is neither an anchor nor a reference site.config.yml declares`);
      return null;
    }).filter(Boolean);

  const questions = [];
  const fragments = {};

  for (const doc of docs) {
    const tokens = doc.tokens;
    const edits = [];

    for (const q of doc.questions) {
      const a = q.attrs;
      const bodyHtml = md.renderer.render(q.bodyTokens, md.options, {});
      const { body, why } = splitWhy(bodyHtml);
      const record = {
        id: `${config.project?.id || 'project'}:${a.slug}`,
        slug: a.slug,
        number: lock.numbers[a.slug],
        audience: a.audience,
        ...(a.to !== undefined ? { to: addressList(a.to) } : {}),
        group: a.group || 'general',
        asked: a.asked,
        margin: a.margin !== 'false',
        resolved: a.resolved || null,
        hidden: a.hidden === 'true',
        doc: doc.slug,
        section: q.section,
        section_title: q.sectionTitle,
        see: resolveSee(a.see, a.slug, doc.slug),
        body,
        why,
      };
      questions.push(record);
      edits.push({ from: q.openIndex, to: q.closeIndex, html: record.margin ? renderAside(record, addressees) : '' });
    }

    // Reverse order: splicing from the end keeps earlier indices valid.
    const Token = tokens[0]?.constructor;
    for (const e of edits.reverse()) {
      const tok = new Token('html_block', '', 0);
      tok.content = e.html;
      tok.block = true;
      tokens.splice(e.from, e.to - e.from + 1, tok);
    }

    fragments[doc.slug] = md.renderer.render(tokens, md.options, {});
  }

  // --- quotes ---------------------------------------------------------------
  // `<i data-answer="slug">...</i>` marks prose that quotes somebody's answer.
  // ⚠️ GENERATE these from the stored text; never retype them. A retyped batch
  // once prettified five sets of quotes into curly ones, and a published quote
  // turned out to be a PREFIX of an answer with a full stop supplied -- and the
  // half it cut was a requirement.
  const quotes = [];
  for (const [docSlug, html] of Object.entries(fragments)) {
    for (const m of html.matchAll(/<i data-answer="([^"]+)"(\s+data-answer-excerpt)?[^>]*>([\s\S]*?)<\/i>/g)) {
      quotes.push({ doc: docSlug, slug: m[1], excerpt: !!m[2], text: m[3].replace(/<[^>]+>/g, '').trim() });
    }
  }
  for (const q of quotes) {
    if (!lock.numbers[q.slug]) errors.push(`a quote in "${q.doc}" names answer "${q.slug}", which is not a question in this project`);
  }

  // --- figures --------------------------------------------------------------
  // `<i data-figure="corpus.base_indicators">689</i>` marks prose that states a
  // number the project MEASURED rather than decided.
  //
  // ⚠️ Same reasoning as quotes, different source. A quote is checked against
  // what a person wrote; a figure is checked against what a probe computed. The
  // rule "never type a count" was only ever enforced for counts about the site
  // itself, which left every domain number in the prose unguarded — and a
  // number that was true when it was typed is the most ordinary way a document
  // goes quietly wrong.
  const figures = [];
  for (const [docSlug, html] of Object.entries(fragments)) {
    for (const m of html.matchAll(/<i data-figure="([^"]+)"[^>]*>([\s\S]*?)<\/i>/g)) {
      figures.push({ doc: docSlug, key: m[1], text: m[2].replace(/<[^>]+>/g, '').trim() });
    }
  }

  // --- cross-document checks -------------------------------------------------
  for (const q of questions) {
    if (!q.resolved) continue;
    const ref = q.resolved.startsWith('#') ? `${q.doc}${q.resolved}` : q.resolved.replace(/^\//, '');
    if (!anchors.has(ref)) errors.push(`question "${q.slug}" is resolved against "${q.resolved}", which is not an anchor any document declares`);
  }

  // Every section's own HTML, so the worksheet can show a referenced passage
  // without navigating away. Generated in the same pass as the fragments, from
  // the same tokens, so the two cannot disagree.
  const sections = {};
  for (const doc of docs) {
    const html = fragments[doc.slug] || '';
    const marks = [...html.matchAll(/<h([1-6])\s+id="([^"]+)"/g)]
      .map((m) => ({ level: Number(m[1]), id: m[2], at: m.index }));
    marks.forEach((mark, i) => {
      const end = marks.slice(i + 1).find((n) => n.level <= mark.level)?.at ?? html.length;
      sections[`${doc.slug}#${mark.id}`] = html.slice(mark.at, end).trim();
    });
  }

  const manifest = {
    project: config.project || {},
    audiences: config.audiences || {},
    ...(addressees ? { addressees } : {}),
    asked_rounds: rounds,
    docs: docs
      .sort((a, b) => a.nav - b.nav || a.slug.localeCompare(b.slug))
      .map((d) => ({ slug: d.slug, title: d.title, nav: d.nav, nav_id: d.nav_id, type: d.type, menu: d.menu, partial: d.partial, date: d.date, author: d.author, source: d.rel, headings: d.headings })),
    questions: questions.sort((a, b) => a.number - b.number),
    quotes,
    figures,
    counts: {
      documents: docs.length,
      questions: questions.length,
      visible: questions.filter((q) => !q.hidden).length,
      resolved: questions.filter((q) => q.resolved).length,
      open: questions.filter((q) => !q.resolved && !q.hidden).length,
    },
  };

  return { ok: errors.length === 0, errors, warnings, manifest, fragments, sections, lock, lockText: serializeLock(lock), assigned, retiredNow };
}
