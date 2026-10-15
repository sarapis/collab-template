// The band layout (`site.layout: band`), rendered by the Worker for one viewer.
//
// Pure: every function takes what it shows and returns HTML. index.js decides
// what the viewer may see (version.js forViewer) and fetches the live data;
// nothing here reads a request, the database or an environment.
//
// The layout (Databook decisions 26 to 35, HOST-CONTRACT.md Part 2):
//   a header BAND: breadcrumb (project / page), the project's name, the pages as
//     pills (Home, then the documents, then `site.nav.artifacts`);
//   a TOOLS box: About, Activity, Questions, Get involved; open with names or
//     icons only, as `project.tools` says, toggled per page with no script;
//   the content, with a status banner when the item has one;
//   the RAIL: the documents, "where things stand", then Contents and Comments;
//   a FOOTER naming the live version, its digest and when it was published.
//
// ⚠️ Every count is computed from the viewer's manifest. None is typed, and none
// is the unfiltered count: a non-member is never told how many members-only
// questions exist.
// ⚠️ The ids the widget hooks (collab-badge, collab-user, collab-signout,
// menu-admin, rail-switch, rail, rail-contents, rail-comments, q-filters, ...)
// are the classic layout's, so collab.js works on both unchanged.

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const ACTIVITY_TYPES = [
  { key: 'decisions', label: 'Decisions' },
  { key: 'posts', label: 'Posts' },
  { key: 'questions', label: 'Questions asked' },
  { key: 'answers', label: 'Answers and comments' },
  { key: 'updates', label: 'Site updates' },
];

// The documents a menu or list shows: written documents, not partials, not the
// About page, not archived (an archived address still opens, with a banner).
export function listedDocs(version, type = 'doc') {
  return version.manifest.docs.filter((d) => d.type === type && !d.partial && !d.menu
    && (version.statuses?.[d.slug] || 'published') !== 'archived');
}

const ICONS = {
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  activity: '<path d="M3 12h4l3 7 4-14 3 7h4"/>',
  questions: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17v.5"/>',
  involved: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 8v6M14 11h6"/>',
};
const icon = (name) => `<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

export const TOOLS = [
  { href: '/about/', label: 'About', icon: 'about' },
  { href: '/activity/', label: 'Activity', icon: 'activity' },
  { href: '/questions/', label: 'Questions', icon: 'questions' },
  { href: '/get-involved/', label: 'Get involved', icon: 'involved' },
];

const ADMIN = (rows) => [
  { href: '/admin/people/', label: 'People' },
  ...(rows ? [{ href: '/admin/content/', label: 'Content' }] : []),
  { href: '/admin/log/', label: 'Conversation log' },
  { href: '/admin/settings/', label: 'Settings' },
];

const cur = (on) => (on ? ' aria-current="page"' : '');

// A contents list made from the rendered headings, the way the classic build's
// transform makes it, so the two layouts cannot disagree about a page.
export function contentsOf(body) {
  const items = [...String(body).matchAll(/<h([23])\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h[23]>/g)]
    .map(([, level, id, text]) => `<li class="l${level}"><a href="#${id}">${text.replace(/<[^>]+>/g, '').trim()}</a></li>`);
  return items.length ? `<ol>${items.join('')}</ol>` : '<p class="muted">No sections on this page.</p>';
}

// ⚠️ A wide table pushes the page sideways on a phone; the classic build wraps
// each one, so this does the same.
const scrollable = (html) => String(html).replace(/<table>([\s\S]*?)<\/table>/g, '<div class="table-scroll"><table>$1</table></div>');

export function standing(m) {
  const c = m.counts;
  return `${plural(c.questions, 'question')} · ${c.open} open · ${c.resolved} resolved · ${plural(c.documents, 'document')}`;
}

export function banner(status) {
  if (status === 'members') return '<div class="status-banner members" role="note"><strong>Members only.</strong> People who are not on this project’s roster cannot see this page, its questions or its sections.</div>';
  if (status === 'archived') return '<div class="status-banner archived" role="note"><strong>Archived.</strong> This page is kept for the record. It has left the menus and lists, and is no longer being worked on.</div>';
  if (status === 'draft') return '<div class="status-banner draft" role="note"><strong>Draft.</strong> A preview of an unsaved edit. Nobody else can see this, and it is not part of any version.</div>';
  return '';
}

function footer(version) {
  if (!version?.digest) return '';
  const when = version.published_at ? String(version.published_at).replace('T', ' ').slice(0, 16) + ' UTC' : null;
  const parts = [`Version <a href="/activity/?type=updates"><code>${esc(version.digest.slice(0, 12))}</code></a>`];
  if (version.id != null) parts[0] = `Version ${esc(version.id)} · <a href="/activity/?type=updates"><code>${esc(version.digest.slice(0, 12))}</code></a>`;
  if (when) parts.push(`published ${esc(when)}`);
  if (version.published_by) parts.push(`by ${esc(version.published_by)}`);
  if (version.commit) parts.push(`from commit <code>${esc(String(version.commit).slice(0, 7))}</code>`);
  return `<footer class="version-foot" data-digest="${esc(version.digest)}">${parts.join(' · ')}</footer>`;
}

// The whole page. `page`: { path, title, body, doc, status, crumb }.
export function layout(ctx, page) {
  const { version, project, settings, chat } = ctx;
  const m = version.manifest;
  const tools = (project.tools || 'closed') === 'open';
  const path = page.path;
  const docs = listedDocs(version);
  const data = listedDocs(version, 'data');
  const artifacts = ctx.navArtifacts || [];

  const pills = [
    `<a class="pill" href="/"${cur(path === '/')}>Home</a>`,
    ...docs.map((d) => `<a class="pill" href="/${esc(d.slug)}/"${cur(path === `/${d.slug}/`)}>${esc(d.title)}</a>`),
    ...artifacts.map((a) => `<a class="pill" href="${esc(a.href)}"${cur(path === a.href)}>${esc(a.label)}</a>`),
  ].join('');

  const crumbs = [`<a href="/">${esc(project.name)}</a>`];
  if (page.crumb) crumbs.push(`<a href="${esc(page.crumb.href)}">${esc(page.crumb.label)}</a>`);
  if (path !== '/') crumbs.push(`<span aria-current="page">${esc(page.title)}</span>`);

  const toolLinks = TOOLS.map((t) => `<a class="tool" href="${t.href}"${cur(path === t.href)} title="${esc(t.label)}">${icon(t.icon)}<span class="tool-label">${esc(t.label)}</span></a>`).join('');
  const adminLinks = ADMIN(settings.content.source === 'rows')
    .map((a) => `<a class="tool" href="${a.href}"${cur(path === a.href)}><span class="tool-label">${esc(a.label)}</span></a>`).join('');

  const railDocs = (list, head) => (list.length
    ? `<p class="menu-head">${head}</p><ul class="rail-docs">${list.map((d) => `<li><a href="/${esc(d.slug)}/"${cur(path === `/${d.slug}/`)}>${esc(d.title)}</a></li>`).join('')}</ul>`
    : '');

  const body = scrollable(page.body);
  const chatPanel = chat?.enabled ? `
<button class="chat-open" type="button" id="chat-open" aria-expanded="false" aria-controls="chat-panel">Ask</button>
<section class="chat-panel" id="chat-panel" hidden aria-label="Ask about this project">
  <header class="chat-head">
    <strong>Ask about this project</strong>
    <a class="chat-log-link" href="/admin/log/">Log</a>
    <button class="chat-close" type="button" id="chat-close" aria-label="Close">&times;</button>
  </header>
  <p class="chat-note">Answers come from what is published here. It cannot change
    anything. <strong>This conversation is stored and the team can read it</strong> —
    kept for ${esc(chat.retention_days)} days.</p>
  <div class="chat-thread" id="chat-thread"></div>
  <div class="chat-compose">
    <textarea id="chat-input" rows="2" placeholder="Ask something about this project"></textarea>
    <button class="btn" type="button" id="chat-send">Ask</button>
  </div>
</section>` : '';

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} · ${esc(project.name)}</title>
<meta name="collab-doc" content="${esc(page.doc || '')}">
${page.noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/band.css">
<link rel="stylesheet" href="/collab.css">
</head>
<body class="band-layout">
<header class="band">
  <div class="band-inner">
    <nav class="crumbs" aria-label="Breadcrumb">${crumbs.join('<span class="crumb-sep" aria-hidden="true">/</span>')}</nav>
    <p class="band-name"><a href="/">${esc(project.name)}</a></p>
    <nav class="pills" aria-label="Pages">${pills}</nav>
  </div>
  <div class="band-account">
    <a class="foot-link badge" id="collab-badge" href="/notifications/"${cur(path === '/notifications/')}>Notifications</a>
    <div class="who-row">
      <span class="who-name" id="collab-user">Account</span>
      <a class="who-out" id="collab-signout" href="/auth/logout" hidden>Sign out</a>
    </div>
  </div>
</header>
<div class="band-shell">
  <input type="checkbox" class="tools-check" id="tools-check"${tools ? ' checked' : ''}>
  <aside class="tools" aria-label="Tools">
    <label class="tools-toggle" for="tools-check"><span class="tools-head">Tools</span></label>
    <nav class="menu tools-list">${toolLinks}
      <div class="menu-admin" id="menu-admin" hidden>
        <p class="menu-head tool-label">Admin</p>${adminLinks}
      </div>
    </nav>
  </aside>
  <main>${banner(page.status)}${body}</main>
  <button class="rail-switch" type="button" id="rail-switch" aria-controls="rail" aria-expanded="true">Hide contents</button>
  <aside class="rail" id="rail">
    <nav class="rail-section" aria-label="Documents">${railDocs(docs, 'Documents')}${railDocs(data, 'Data')}</nav>
    <section class="rail-section">
      <p class="menu-head">Where things stand</p>
      <p class="counts">${standing(m)}</p>
    </section>
    <div class="rail-tabs" role="tablist">
      <button class="rail-tab" type="button" data-rail="contents" aria-selected="true">Contents</button>
      <button class="rail-tab" type="button" data-rail="comments" aria-selected="false">Comments</button>
    </div>
    <nav class="toc" id="rail-contents">${contentsOf(body)}</nav>
    <div class="rail-comments" id="rail-comments" hidden data-comments-for="${esc(page.doc || '')}">
      <p class="muted">Comments load when you are signed in.</p>
    </div>
  </aside>
</div>
${footer(version)}${chatPanel}
<script src="/collab.js" defer></script>
</body>
</html>
`;
}

// --- pages -----------------------------------------------------------------

const fragment = (version, slug) => version.fragments?.[slug] || '';

export function openByAudience(m) {
  const counts = new Map();
  for (const q of m.questions) {
    if (q.resolved || q.hidden) continue;
    counts.set(q.audience, (counts.get(q.audience) || 0) + 1);
  }
  return [...counts.entries()].map(([audience, count]) => ({ audience, count })).sort((a, b) => b.count - a.count);
}

// The activity feed's items, newest first. `live` carries what only the
// database knows: answers, comments and versions, each already limited to what
// the viewer may see.
export function activityItems(version, live = {}) {
  const m = version.manifest;
  const siteDecisions = new Set(m.project?.site_decisions || []);
  const items = [];
  for (const d of m.docs) {
    if (d.partial || (version.statuses?.[d.slug] || 'published') === 'archived') continue;
    if (d.type === 'decision') items.push({ type: 'decisions', at: d.date, doc: d, tag: siteDecisions.has(d.slug) ? 'About this site' : null });
    if (d.type === 'post') items.push({ type: 'posts', at: d.date, doc: d });
  }
  for (const [key, r] of Object.entries(m.asked_rounds || {})) {
    const n = m.questions.filter((q) => q.asked === key && !q.hidden).length;
    items.push({ type: 'questions', at: r.opened, round: { key, label: r.label || key, count: n } });
  }
  for (const a of live.answers || []) items.push({ type: 'answers', at: a.created_at, answer: a });
  for (const c of live.comments || []) items.push({ type: 'answers', at: c.created_at, comment: c });
  for (const v of live.versions || []) items.push({ type: 'updates', at: v.published_at, version: v });
  return items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

const day = (at) => String(at || '').slice(0, 10);

function activityItem(version, it) {
  const m = version.manifest;
  if (it.doc) {
    const d = it.doc;
    const meta = [day(d.date), d.author ? esc(d.author) : null, it.tag ? `<span class="tag">${esc(it.tag)}</span>` : null,
      `<a href="/${esc(d.slug)}/">permalink</a>`].filter(Boolean).join(' · ');
    return `<article class="card activity-item" data-type="${it.type}"><p class="counts">${it.type === 'decisions' ? 'Decision' : 'Post'} · ${meta}</p>${fragment(version, d.slug)}</article>`;
  }
  if (it.round) {
    return `<article class="card activity-item" data-type="questions"><p class="counts">Questions asked · ${esc(day(it.at))}</p>
<p><strong>${esc(it.round.label)}</strong>: ${plural(it.round.count, 'question')} on the site. <a href="/questions/">See them →</a></p></article>`;
  }
  if (it.answer) {
    const q = m.questions.find((x) => x.id === it.answer.question_id);
    const where = q ? `<a href="/questions/#q${q.number}">Q${q.number}</a>` : 'a question';
    return `<article class="card activity-item" data-type="answers"><p class="counts">Answer · ${esc(day(it.at))} · ${esc(it.answer.author_name)} on ${where}</p><p>${esc(it.answer.body)}</p></article>`;
  }
  if (it.comment) {
    const d = it.comment.doc ? m.docs.find((x) => x.slug === it.comment.doc) : null;
    const where = d ? `<a href="/${esc(d.slug)}/">${esc(d.title)}</a>` : 'the project';
    return `<article class="card activity-item" data-type="answers"><p class="counts">Comment · ${esc(day(it.at))} · ${esc(it.comment.author_name)} on ${where}</p><p>${esc(it.comment.body)}</p></article>`;
  }
  const v = it.version;
  return `<article class="card activity-item" data-type="updates"><p class="counts">Site update · ${esc(String(it.at || '').replace('T', ' ').slice(0, 16))}${v.published_by ? ` · ${esc(v.published_by)}` : ''}</p>
<p>${v.id != null ? `Version ${esc(v.id)}, ` : 'The live version, '}digest <code>${esc(String(v.digest).slice(0, 12))}</code>${v.reason ? `: ${esc(v.reason)}` : ''}${v.live ? ' <span class="tag">live</span>' : ''}</p></article>`;
}

export function activityPage(version, live, type) {
  const known = ACTIVITY_TYPES.some((t) => t.key === type);
  const want = known ? type : null;
  const items = activityItems(version, live).filter((it) => !want || it.type === want);
  const filters = [{ key: null, label: 'All' }, ...ACTIVITY_TYPES]
    .map((t) => `<a class="filter" href="/activity/${t.key ? `?type=${t.key}` : ''}" aria-pressed="${t.key === want ? 'true' : 'false'}">${esc(t.label)}</a>`).join('');
  const label = want ? ACTIVITY_TYPES.find((t) => t.key === want).label : null;
  return `<h1>Activity</h1>
<p class="lede">Everything that happened on this site, newest first${label ? `: ${esc(label.toLowerCase())} only` : ''}.</p>
<nav class="filters" aria-label="Filter activity">${filters}</nav>
${items.length ? items.map((it) => activityItem(version, it)).join('\n') : '<p class="muted">Nothing of this kind yet.</p>'}`;
}

export function questionsPage(version) {
  const m = version.manifest;
  const declared = m.project?.groups || [];
  const present = [...new Set(m.questions.map((q) => q.group))];
  const order = [...declared.map((g) => g.key).filter((k) => present.includes(k)), ...present.filter((k) => !declared.some((g) => g.key === k)).sort()];
  const label = (k) => declared.find((g) => g.key === k)?.label || k;
  const card = (q) => {
    const see = (q.see || []).length ? `<p class="q-see">Context: ${q.see.map((r) => (r.kind === 'section'
      ? `<a href="/${esc(r.doc)}/#${esc(r.section)}" data-see-section="${esc(r.doc)}#${esc(r.section)}">${esc(r.title || r.section)}</a>`
      : `<a href="${esc(r.url)}" rel="noreferrer" target="_blank">${esc(r.label)} ↗</a>`)).join(' · ')}</p>` : '';
    return `<article class="card ${q.resolved ? 'resolved' : 'open'}" id="q${q.number}" data-question="${esc(q.id)}" data-audience="${esc(q.audience)}" data-resolved="${q.resolved ? 'true' : 'false'}" data-asked="${esc(q.asked)}">
<header class="q-head"><a class="q-num" href="/${esc(q.doc)}/${q.margin ? `#q${q.number}` : ''}">Q${q.number}</a> <span class="q-audience">${esc(q.audience)}</span>${m.asked_rounds?.[q.asked]?.new ? '<span class="q-audience">· new this round</span>' : ''}</header>
<div class="q-body">${q.body}</div>
${q.why ? `<div class="q-why"><strong>Why asked:</strong> ${q.why}</div>` : ''}${see}
${q.resolved ? `<p class="q-resolved-note">resolved · see <a href="/${esc(q.doc)}/${esc(q.resolved)}">this passage</a></p>` : ''}
<div class="q-answers" data-answers-for="${esc(q.id)}" data-round-opened="${esc(m.asked_rounds?.[q.asked]?.opened || '')}"></div>
</article>`;
  };
  return `<h1>Questions</h1>
<p class="counts" id="q-counts">${m.counts.questions} total · ${m.counts.open} open · ${m.counts.resolved} resolved</p>
<p class="counts">Every count on this page is computed from the live version. None is typed.</p>
<nav class="filters" id="q-filters" aria-label="Filter questions">
  <button class="filter" type="button" data-show="all" aria-pressed="true">All</button>
  <button class="filter" type="button" data-show="waiting">Waiting for you</button>
  <button class="filter" type="button" data-show="unanswered">Unanswered</button>
  <button class="filter" type="button" data-show="answered">Answered, not folded in</button>
</nav>
<p class="counts" id="q-filter-note"></p>
${order.map((g) => `<h2 id="g-${esc(g)}">${esc(label(g))}</h2>
<div class="cards">
${m.questions.filter((q) => q.group === g && !q.hidden).map(card).join('\n')}
</div>`).join('\n')}`;
}

export function homePage(version, live = {}) {
  const m = version.manifest;
  const p = m.project || {};
  const docs = listedDocs(version);
  const summary = m.docs.find((d) => d.slug === 'summary' && d.partial);
  const latest = activityItems(version, live).find((it) => it.doc || it.round);
  const waiting = live.waiting == null ? '' : `<p class="counts">${live.waiting} waiting for you</p>`;
  return `<h1>${esc(p.name)}</h1>
${p.tagline ? `<p class="lede">${esc(p.tagline)}</p>` : ''}
${summary ? fragment(version, 'summary') : ''}
<div class="cards home-cards">
  <a class="card home-card" href="/questions/"><span class="home-kicker">Questions</span><strong class="home-figure">${m.counts.open}</strong><span class="counts">open of ${m.counts.visible}</span>${waiting}</a>
  <a class="card home-card" href="#documents"><span class="home-kicker">Documents</span><strong class="home-figure">${docs.length}</strong><span class="counts">being worked on</span></a>
  <a class="card home-card" href="/activity/"><span class="home-kicker">Activity</span>${latest ? `<span class="home-latest">${esc(latest.doc ? latest.doc.title : latest.round.label)}</span><span class="counts">${esc(day(latest.at))}</span>` : '<span class="counts">Nothing yet</span>'}</a>
</div>
<h2 id="documents">Documents</h2>
<div class="cards">
${docs.map((d) => {
    const n = m.questions.filter((q) => q.doc === d.slug && !q.hidden && !q.resolved).length;
    const sections = (d.headings || []).filter((h) => h.level === 2 && h.id).length;
    return `<article class="card"><p><a href="/${esc(d.slug)}/"><strong>${esc(d.title)}</strong></a></p><p class="counts">${plural(sections, 'section')} · ${n} open</p></article>`;
  }).join('\n') || '<p class="muted">No documents yet.</p>'}
</div>
<h2 id="next">Where to go next</h2>
<div class="cards">
  <a class="orient" href="/about/"><span class="orient-kicker">New here?</span><span class="orient-title">About</span><span class="orient-detail">What this project is, how the site works, and where things stand.</span></a>
  <a class="orient" href="/get-involved/"><span class="orient-kicker">Taking part</span><span class="orient-title">Get involved</span><span class="orient-detail">Answer a question, leave a comment, or connect your AI assistant.</span></a>
</div>`;
}

export function aboutPage(version) {
  const m = version.manifest;
  const rows = openByAudience(m);
  return `${fragment(version, 'start')}
<h2 id="where-things-stand">Where things stand</h2>
<p class="counts">${standing(m)}</p>
<p class="counts">Every figure here is computed from the live version. None is typed.</p>
<div class="cards">
${rows.map((r) => `<article class="card open"><p class="counts">${esc(m.audiences?.[r.audience]?.name || r.audience)}</p><p><strong>${r.count}</strong> ${r.count === 1 ? 'question' : 'questions'} still open. ${esc(m.audiences?.[r.audience]?.describes || '')}</p></article>`).join('\n') || '<article class="card"><p>Nothing is open. Every question has been resolved.</p></article>'}
</div>`;
}

export function getInvolvedPage(version, { origin, publicRead }) {
  const own = version.manifest.docs.find((d) => d.slug === 'get-involved');
  const mcp = JSON.stringify({ mcpServers: { [version.manifest.project?.id || 'collab']: {
    type: 'http', url: `${origin}/mcp`, headers: { Authorization: 'Bearer <your token>' } } } }, null, 2);
  return `<h1>Get involved</h1>
${own ? fragment(version, 'get-involved') : ''}
<h2 id="ways-in">Ways in</h2>
<h3 id="sign-in">Sign in</h3>
<p>The people on this project’s roster sign in at <a href="/auth/login">the sign-in page</a>. ${publicRead ? 'Anyone may read; answering and commenting need a sign-in.' : 'Everything here needs a sign-in.'} Access is by invitation: ask whoever runs the project to add your address.</p>
<h3 id="answer">Answer and comment</h3>
<p>Every open question is on <a href="/questions/">Questions</a> and beside the passage that raised it. Answer in the margin, or leave a comment on any document from the Comments tab.</p>
<h3 id="connect-ai">Connect your AI assistant</h3>
<p>Claude Code and Claude Desktop use this site’s MCP server at <code>${esc(origin)}/mcp</code> with a personal token an admin issues you:</p>
<pre><code>${esc(mcp)}</code></pre>
<p>claude.ai and Claude on a phone cannot send a token; add <code>${esc(origin)}/connect</code> as a custom connector instead and sign in when it asks.</p>`;
}

export function docPage(version, slug) {
  return fragment(version, slug);
}

// The public index at /llms.txt for a PUBLIC rows instance: built from what an
// anonymous reader may see, so a members-only document is never listed.
export function publicIndex(version, pub = {}) {
  const m = version.manifest;
  const list = (type, head) => {
    const docs = listedDocs(version, type);
    return docs.length ? ['', `## ${head}`, '', ...docs.map((d) => `- [${d.title}](/${d.slug}/)`)] : [];
  };
  return [`# ${m.project?.name || 'A collaboration site'}`, '', m.project?.tagline ? `> ${m.project.tagline}` : null, '',
    '- [About](/about/): what this project is and where it stands.',
    `- [Questions](/questions/): ${m.counts.open} open.`,
    '- [Activity](/activity/): what happened, newest first.',
    '- [Get involved](/get-involved/): how to take part.',
    ...list('doc', 'Documents'), ...list('data', 'Data reports'), '',
    pub.repo ? `Repository: ${pub.repo}` : null, pub.contact ? `Contact: ${pub.contact}.` : null,
  ].filter((l) => l !== null).join('\n') + '\n';
}
