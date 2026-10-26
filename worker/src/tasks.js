// Tasks (`tasks.enabled`; v1.13.0): the work a question, an answer, a decision,
// a comment or a request creates, kept on the site so the people who answered
// can see what is being done about it.
//
// ⚠️ ONE read rule and ONE write path. The API (/api/tasks), the MCP tools, the
// pages (/tasks/), Activity and the notifications all call the functions in
// this file, so no door can show a task another would hide, or write one past a
// rule another enforces.
//
// Who may do what:
//   read      a signed-in person (even on a public site: a task names people
//             and carries working notes), and only a task whose `doc` the
//             viewer may see (band.js viewFor: a draft or members-only
//             document's task follows its document)
//   comment   the same people, while not disabled
//   write     an editor (identity.js isEditor), or an editor's agent token
//
// ⚠️ A person's email address is stored (it is who they are) and never sent:
// every shape here carries names.
import { hostOf, viewFor, commentsFor } from './band.js';
import { isEditor } from './identity.js';
import { overLimit } from './limits.js';
import { findByEmail, listPeople } from './people.js';
import { declaredGroups, groupName } from './waits.js';
import { LINK_KIND } from './settings.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// In display order on the list: what is moving first, what is finished last.
export const STATUSES = [
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'open', label: 'Open' },
  { key: 'idea', label: 'Idea' },
  { key: 'done', label: 'Done' },
  { key: 'dropped', label: 'Dropped' },
];
// The order a task moves through, for the status menu.
const FLOW = ['idea', 'open', 'in_progress', 'review', 'done', 'dropped'];
const LABEL = Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));
const CLOSED = new Set(['done', 'dropped']);
export const SOURCE_KINDS = ['question', 'answer', 'decision', 'comment', 'request', 'external'];
const MAX_TITLE = 200;
const MAX_REF = 500;
const MAX_LINKS = 20;
const URL_OK = /^https?:\/\/[^\s"'<>]+$/;

export const tasksOn = (env) => hostOf(env)?.tasks?.enabled === true && hostOf(env)?.settings?.layout === 'band';
const linkKinds = (env) => hostOf(env)?.tasks?.link_kinds || {};
const signedIn = (me) => !!me?.authenticated && !me.disabled;
const now = () => new Date().toISOString();
const fail = (status, error) => ({ ok: false, status, error });

// The task number from "T7", "7" or 7; null if it is none of those.
export function numberOf(x) {
  const m = String(x ?? '').trim().match(/^T?(\d{1,9})$/i);
  return m ? Number(m[1]) : null;
}

// What this viewer may see of the live version, as the task rules need it.
async function viewerCtx(request, env, me) {
  const v = await viewFor(request, env, me);
  const m = v?.view.manifest || { docs: [], questions: [] };
  return { m, sections: v?.view.sections || {}, docs: new Set(m.docs.map((d) => d.slug)) };
}

// ⚠️ THE read rule. Everything that shows a task asks this.
const readable = (row, ctx, me) => signedIn(me) && (!row.doc || ctx.docs.has(row.doc));

async function namesOf(env) {
  const people = await listPeople(env).catch(() => []);
  return new Map(people.map((p) => [p.email, p.name]));
}

function questionOf(ctx, qid) {
  return qid ? ctx.m.questions.find((q) => q.id === qid) || null : null;
}

function sourceOf(row, ctx) {
  const q = questionOf(ctx, row.question_id);
  const qref = q ? { number: q.number, slug: q.slug } : null;
  const anchor = row.source_anchor || null;
  switch (row.source_kind) {
    case 'question':
      return { kind: 'question', question: qref, doc: row.doc, anchor, label: q ? `Q${q.number}` : 'a question',
        href: q ? `/questions/#q${q.number}` : null };
    case 'answer':
      return { kind: 'answer', question: qref, doc: row.doc, anchor, label: q ? `an answer to Q${q.number}` : 'an answer',
        href: q ? `/questions/#q${q.number}` : null };
    case 'decision': {
      const d = ctx.m.docs.find((x) => x.slug === row.doc);
      return { kind: 'decision', question: null, doc: row.doc, anchor,
        label: d ? d.title : row.doc, href: `/${row.doc}/${anchor ? `#${anchor}` : ''}` };
    }
    case 'comment':
      return { kind: 'comment', question: null, doc: row.doc, anchor: null, label: 'a comment', href: row.doc ? `/${row.doc}/` : null };
    case 'external':
      return { kind: 'external', question: null, doc: null, anchor: null, label: row.source_ref || 'outside this site',
        href: URL_OK.test(row.source_ref || '') ? row.source_ref : null };
    default:
      return { kind: 'request', question: null, doc: null, anchor: null, label: row.source_ref || 'a request', href: null };
  }
}

function linksOf(row, env) {
  const kinds = linkKinds(env);
  let list = [];
  try { list = JSON.parse(row.links || '[]'); } catch { list = []; }
  return list.map((l) => {
    const k = kinds[l.kind];
    const href = k ? k.url.replace('{ref}', encodeURIComponent(l.ref)) : (URL_OK.test(l.url || '') ? l.url : null);
    return { kind: l.kind, ref: l.ref, label: l.label || k?.label || (l.kind === 'pr' ? 'PR' : l.kind), href };
  });
}

function assigneeOf(row, ctx, me, names) {
  if (row.assignee_kind === 'group') {
    return { kind: 'group', key: row.assignee, name: groupName(ctx.m, row.assignee), mine: (me?.audiences || []).includes(row.assignee) };
  }
  if (row.assignee_kind === 'person') {
    return { kind: 'person', name: names.get(row.assignee) || 'someone on the roster', mine: !!me?.sub && row.assignee === me.sub };
  }
  return null;
}

function shape(row, ctx, me, names, env) {
  return {
    number: row.number, ref: `T${row.number}`, href: `/tasks/T${row.number}/`,
    title: row.title, body: row.body, status: row.status, status_label: LABEL[row.status] || row.status,
    assignee: assigneeOf(row, ctx, me, names), source: sourceOf(row, ctx), links: linksOf(row, env),
    created_by: row.created_by_name, created_at: row.created_at, updated_at: row.updated_at, closed_at: row.closed_at || null,
  };
}

function eventValue(kind, v, ctx, names) {
  if (v == null) return null;
  if (kind === 'status') return LABEL[v] || v;
  if (kind === 'assignee') {
    const [k, ...rest] = String(v).split(':');
    const key = rest.join(':');
    return k === 'group' ? groupName(ctx.m, key) : (names.get(key) || 'someone on the roster');
  }
  return v;
}

const eventShape = (e, ctx, names) => ({
  kind: e.kind, at: e.at, by: e.by_name,
  from: eventValue(e.kind, e.from_value, ctx, names), to: eventValue(e.kind, e.to_value, ctx, names),
  note: e.note || null,
});

async function rowByNumber(env, n) {
  return n == null ? null : env.DB.prepare('SELECT * FROM tasks WHERE number = ?').bind(n).first();
}

// --- reads ----------------------------------------------------------------------

// The tasks this viewer may see, oldest first. Filters: status, mine (assigned to
// them or a group they are in), question (a question number or id).
export async function listTasks(request, env, me, filters = {}) {
  const ctx = await viewerCtx(request, env, me);
  const names = await namesOf(env);
  const { results } = await env.DB.prepare('SELECT * FROM tasks ORDER BY number').all();
  let rows = (results || []).filter((r) => readable(r, ctx, me));
  if (filters.status) rows = rows.filter((r) => r.status === filters.status);
  if (filters.mine) rows = rows.filter((r) => (r.assignee_kind === 'person' && r.assignee === me.sub)
    || (r.assignee_kind === 'group' && (me.audiences || []).includes(r.assignee)));
  if (filters.pr) {
    // The task(s) a pull request belongs to, by either spelling of the PR.
    const want = prRef(filters.pr);
    rows = rows.filter((r) => want && JSON.parse(r.links || '[]').some((l) => l.kind === 'pr' && l.ref === want));
  }
  if (filters.question) {
    const n = numberOf(String(filters.question).replace(/^Q/i, ''));
    const q = ctx.m.questions.find((x) => x.id === filters.question || x.number === n);
    rows = rows.filter((r) => q && r.question_id === q.id);
  }
  return rows.map((r) => shape(r, ctx, me, names, env));
}

// One task with its history and comments, or null when this viewer may not see it.
// ⚠️ "May not see" and "does not exist" are the same answer.
export async function readTask(request, env, me, n) {
  const row = await rowByNumber(env, numberOf(n));
  const ctx = await viewerCtx(request, env, me);
  if (!row || !readable(row, ctx, me)) return null;
  const names = await namesOf(env);
  const { results } = await env.DB.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY at, rowid').bind(row.id).all();
  return { ...shape(row, ctx, me, names, env), events: (results || []).map((e) => eventShape(e, ctx, names)) };
}

// The tasks each question spawned, for the questions page and the margin.
export async function tasksByQuestion(request, env, me) {
  const map = new Map();
  if (!signedIn(me)) return map;
  for (const t of await listTasks(request, env, me)) {
    const q = t.source.question;
    if (!q) continue;
    if (!map.has(q.number)) map.set(q.number, []);
    map.get(q.number).push(t);
  }
  return map;
}

// --- writes (the one write path) --------------------------------------------------

async function resolveSource(src, ctx, env, me) {
  const kind = src?.kind;
  if (!SOURCE_KINDS.includes(kind)) return fail(400, `source.kind is one of ${SOURCE_KINDS.join(', ')}`);
  const ref = src.ref == null ? '' : String(src.ref).trim();
  if (ref.length > MAX_REF) return fail(400, `source.ref is at most ${MAX_REF} characters`);
  const anchorIn = (doc, a) => {
    const id = String(a || '').replace(/^#/, '').trim();
    return id && ctx.sections[`${doc}#${id}`] != null ? id : null;
  };

  if (kind === 'question') {
    const n = numberOf(ref.replace(/^Q/i, ''));
    const q = ctx.m.questions.find((x) => !x.hidden && (x.number === n || x.slug === ref || x.id === ref));
    if (!q) return fail(400, `no question "${ref}" that you can see`);
    let anchor = null;
    if (src.anchor) {
      anchor = anchorIn(q.doc, src.anchor);
      if (!anchor) return fail(400, `no section "${src.anchor}" in ${q.doc}`);
    } else if (q.resolved) anchor = String(q.resolved).replace(/^#/, '') || null;
    return { ok: true, source_ref: q.id, question_id: q.id, doc: q.doc, anchor };
  }
  if (kind === 'answer') {
    const a = ref ? await env.DB.prepare('SELECT id, question_id FROM answers WHERE id = ?').bind(ref).first() : null;
    const q = a && ctx.m.questions.find((x) => x.id === a.question_id);
    if (!q) return fail(400, `no answer "${ref}" that you can see`);
    return { ok: true, source_ref: a.id, question_id: q.id, doc: q.doc, anchor: null };
  }
  if (kind === 'decision') {
    const [doc, a] = ref.split('#');
    if (!doc || !ctx.docs.has(doc)) return fail(400, `no document "${doc}" that you can see`);
    const anchor = a ? anchorIn(doc, a) : null;
    if (a && !anchor) return fail(400, `no section "#${a}" in ${doc}`);
    return { ok: true, source_ref: anchor ? `${doc}#${anchor}` : doc, question_id: null, doc, anchor };
  }
  if (kind === 'comment') {
    const c = (await commentsFor(env, me, ctx.docs)).find((x) => x.id === ref);
    if (!c) return fail(400, `no comment "${ref}" that you can see`);
    return { ok: true, source_ref: c.id, question_id: null, doc: c.doc || null, anchor: null };
  }
  // request | external: from outside the documents, so read as the site is.
  return { ok: true, source_ref: ref || null, question_id: null, doc: null, anchor: null };
}

async function resolveAssignee(a, ctx, env) {
  if (a == null || a === '') return { ok: true, kind: null, key: null };
  const key = String(a.key || '').trim();
  if (a.kind === 'group') {
    if (!declaredGroups(ctx.m).some((g) => g.id === key)) return fail(400, `no group "${key}": groups are the site's audiences and addressees`);
    return { ok: true, kind: 'group', key };
  }
  if (a.kind === 'person') {
    const p = await findByEmail(env, key);
    if (!p || p.disabled) return fail(400, 'no such person on this project’s roster');
    return { ok: true, kind: 'person', key: p.email };
  }
  return fail(400, 'assignee is {kind: "person" | "group", key}');
}

// A GitHub pull request, built in so no instance has to configure it: `pr` with
// `owner/repo#123`, or a pasted https://github.com/owner/repo/pull/123 (with or
// without `pr`). Both are stored as the same {kind: 'pr', ref, url}, so a PR is
// found by one spelling whichever way it was typed.
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const PR_REF = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
export function prRef(x) {
  const s = String(x || '').trim();
  const m = s.match(PR_URL) || s.match(PR_REF);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
}
const prLink = (ref) => {
  const [repo, n] = ref.split('#');
  return { kind: 'pr', ref, url: `https://github.com/${repo}/pull/${n}` };
};

function cleanLinks(list) {
  if (list == null) return { ok: true, links: [] };
  if (!Array.isArray(list) || list.length > MAX_LINKS) return fail(400, `links is a list of at most ${MAX_LINKS} {kind, ref, url?}`);
  const out = [];
  for (const l of list) {
    let kind = String(l?.kind || '').trim();
    let ref = String(l?.ref ?? '').trim();
    const pr = (kind === 'pr' || !kind) ? prRef(l?.url) || prRef(ref) : null;
    if (pr) { out.push({ ...prLink(pr), ...(l.label ? { label: String(l.label).slice(0, 100) } : {}) }); continue; }
    if (kind === 'pr') return fail(400, 'a PR link is owner/repo#123, or a https://github.com/owner/repo/pull/123 URL');
    if (!kind && URL_OK.test(String(l?.url || ''))) { kind = 'link'; ref = ref || String(l.url); }
    if (!LINK_KIND.test(kind)) return fail(400, `a link's kind is lowercase letters, digits, - and _ (got "${kind}")`);
    if (!ref || ref.length > MAX_REF) return fail(400, `a link's ref is 1 to ${MAX_REF} characters`);
    // ⚠️ Only http(s): anything else in an href is a script waiting to be clicked.
    if (l.url != null && l.url !== '' && !(URL_OK.test(String(l.url)) && String(l.url).length <= MAX_REF)) {
      return fail(400, `a link's url is http(s) (got "${String(l.url).slice(0, 40)}")`);
    }
    out.push({ kind, ref, ...(l.url ? { url: String(l.url) } : {}), ...(l.label ? { label: String(l.label).slice(0, 100) } : {}) });
  }
  return { ok: true, links: out };
}

function cleanTitle(t) {
  const title = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return fail(400, 'a task needs a title');
  if (title.length > MAX_TITLE) return fail(400, `a title is at most ${MAX_TITLE} characters`);
  return { ok: true, title };
}

function writeGate(env, me) {
  if (!tasksOn(env)) return fail(404, 'no such route');
  if (!signedIn(me)) return fail(401, 'not signed in');
  if (!isEditor(me)) return fail(403, 'only editors create and change tasks');
  return null;
}

const event = (env, taskId, me, kind, from, to, note, at) => env.DB.prepare(
  'INSERT INTO task_events (id, task_id, at, by_sub, by_name, kind, from_value, to_value, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .bind(crypto.randomUUID(), taskId, at, me.sub, me.name, kind, from ?? null, to ?? null, note ?? null);

// An event written only if the UPDATE before it in the same batch applied (the
// task now carries this update's `at`), so a write that lost a race leaves no
// history of a change that never happened.
const eventIfApplied = (env, taskId, me, kind, from, to, note, at) => env.DB.prepare(
  `INSERT INTO task_events (id, task_id, at, by_sub, by_name, kind, from_value, to_value, note)
   SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND updated_at = ?)`)
  .bind(crypto.randomUUID(), taskId, at, me.sub, me.name, kind, from ?? null, to ?? null, note ?? null, taskId, at);

// Create a task. Input: {title, body?, status?, source: {kind, ref, anchor?},
// assignee?: {kind, key}, links?: [{kind, ref, url?}]}.
export async function createTask(input, request, env, me) {
  const gate = writeGate(env, me);
  if (gate) return gate;
  const t = cleanTitle(input?.title);
  if (!t.ok) return t;
  const body = String(input?.body ?? '').trim();
  const long = overLimit(body);
  if (long) return fail(400, long);
  const status = input?.status || 'open';
  if (!FLOW.includes(status) || CLOSED.has(status)) return fail(400, 'a new task is idea, open, in_progress or review');
  const ctx = await viewerCtx(request, env, me);
  const src = await resolveSource(input?.source, ctx, env, me);
  if (!src.ok) return src;
  const who = await resolveAssignee(input?.assignee, ctx, env);
  if (!who.ok) return who;
  const links = cleanLinks(input?.links);
  if (!links.ok) return links;

  const id = crypto.randomUUID();
  const at = now();
  // ⚠️ The number is computed INSIDE the insert, so two creates cannot read the
  // same MAX; UNIQUE(number) is the backstop, and a collision retries.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO tasks (id, number, title, body, status, assignee_kind, assignee, source_kind, source_ref,
            source_anchor, question_id, doc, links, created_by_sub, created_by_name, created_at, updated_at)
          SELECT ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM tasks`)
          .bind(id, t.title, body, status, who.kind, who.key, input.source.kind, src.source_ref, src.anchor, src.question_id,
            src.doc, JSON.stringify(links.links), me.sub, me.name, at, at),
        event(env, id, me, 'created', null, status, null, at),
      ]);
      break;
    } catch (e) {
      if (attempt === 2 || !/UNIQUE/i.test(String(e?.message))) throw e;
    }
  }
  return { ok: true, status: 201, task: await readTask(request, env, me, (await env.DB.prepare('SELECT number FROM tasks WHERE id = ?').bind(id).first()).number) };
}

// Change a task. Input: {base_updated_at, title?, body?, status?, note?,
// assignee? (null clears), add_links?, remove_links?: [{kind, ref}]}.
// ⚠️ `base_updated_at` is the version the editor was looking at; a task changed
// since then is refused (409), never silently overwritten.
export async function updateTask(n, input, request, env, me) {
  const gate = writeGate(env, me);
  if (gate) return gate;
  const row = await rowByNumber(env, numberOf(n));
  const ctx = await viewerCtx(request, env, me);
  if (!row || !readable(row, ctx, me)) return fail(404, `no such task T${numberOf(n) ?? n}`);
  if (!input?.base_updated_at || input.base_updated_at !== row.updated_at) {
    return fail(409, `T${row.number} has changed since you opened it (or the update named no base_updated_at). Read it again and reapply.`);
  }

  const at = new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString();
  const sets = [];
  const binds = [];
  const events = [];
  const note = input.note == null ? '' : String(input.note).trim();
  const noteLong = overLimit(note);
  if (noteLong) return fail(400, noteLong);

  if (input.title != null && String(input.title).trim() !== row.title) {
    const t = cleanTitle(input.title);
    if (!t.ok) return t;
    sets.push('title = ?'); binds.push(t.title);
    events.push(['edit', row.title, t.title, 'title']);
  }
  if (input.body != null && String(input.body).trim() !== row.body) {
    const body = String(input.body).trim();
    const long = overLimit(body);
    if (long) return fail(400, long);
    sets.push('body = ?'); binds.push(body);
    events.push(['edit', row.body, body, 'body']);
  }
  let statusChanged = false;
  if (input.status != null && input.status !== row.status) {
    if (!FLOW.includes(input.status)) return fail(400, `status is one of ${FLOW.join(', ')}`);
    // ⚠️ Done needs evidence: a task closes with a note saying what was done (or
    // why it was dropped), which is what the people who answered are shown.
    if (CLOSED.has(input.status) && !note) {
      return fail(400, `${LABEL[input.status]} needs a closing note: say what was done, or why it was dropped.`);
    }
    sets.push('status = ?', 'closed_at = ?'); binds.push(input.status, CLOSED.has(input.status) ? at : null);
    events.push(['status', row.status, input.status, note || null]);
    statusChanged = true;
  }
  if (input.assignee !== undefined) {
    const who = await resolveAssignee(input.assignee, ctx, env);
    if (!who.ok) return who;
    const before = row.assignee_kind ? `${row.assignee_kind}:${row.assignee}` : null;
    const after = who.kind ? `${who.kind}:${who.key}` : null;
    if (before !== after) {
      sets.push('assignee_kind = ?', 'assignee = ?'); binds.push(who.kind, who.key);
      events.push(['assignee', before, after, null]);
    }
  }
  if (input.add_links != null || input.remove_links != null) {
    let current = [];
    try { current = JSON.parse(row.links || '[]'); } catch { current = []; }
    const add = cleanLinks(input.add_links || []);
    if (!add.ok) return add;
    const drop = (input.remove_links || []).map((l) => `${l?.kind}\u0000${l?.ref}`);
    const next = [...current.filter((l) => !drop.includes(`${l.kind}\u0000${l.ref}`)), ...add.links];
    if (next.length > MAX_LINKS) return fail(400, `a task has at most ${MAX_LINKS} links`);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      sets.push('links = ?'); binds.push(JSON.stringify(next));
      for (const l of add.links) events.push(['link', null, `${l.kind}: ${l.ref}`, null]);
      for (const l of current.filter((x) => drop.includes(`${x.kind}\u0000${x.ref}`))) events.push(['link', `${l.kind}: ${l.ref}`, null, null]);
    }
  }
  // A note with no status change is a comment by the editor.
  if (note && !statusChanged) events.push(['comment', null, null, note]);
  if (!sets.length && !events.length) return { ok: true, status: 200, task: await readTask(request, env, me, row.number) };

  const stmts = [];
  if (sets.length) {
    stmts.push(env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND updated_at = ?`)
      .bind(...binds, at, row.id, row.updated_at));
  }
  const write = sets.length ? eventIfApplied : event;
  for (const [kind, from, to, n2] of events) stmts.push(write(env, row.id, me, kind, from, to, n2, at));
  await env.DB.batch(stmts);
  if (sets.length) {
    const after = await env.DB.prepare('SELECT updated_at FROM tasks WHERE id = ?').bind(row.id).first();
    if (after?.updated_at !== at) return fail(409, `T${row.number} was changed by somebody else at the same moment. Read it again and reapply.`);
  }
  return { ok: true, status: 200, task: await readTask(request, env, me, row.number) };
}

// A comment on a task, by anybody who may read it.
export async function commentOnTask(n, body, request, env, me) {
  if (!tasksOn(env)) return fail(404, 'no such route');
  if (!signedIn(me)) return fail(401, 'not signed in');
  const row = await rowByNumber(env, numberOf(n));
  const ctx = await viewerCtx(request, env, me);
  if (!row || !readable(row, ctx, me)) return fail(404, `no such task T${numberOf(n) ?? n}`);
  const text = String(body ?? '').trim();
  if (!text) return fail(400, 'say something');
  const long = overLimit(text);
  if (long) return fail(400, long);
  await event(env, row.id, me, 'comment', null, null, text, now()).run();
  return { ok: true, status: 201, task: await readTask(request, env, me, row.number) };
}

// --- what the rest of the site shows ----------------------------------------------

// Activity: each task made and each task closed, newest last, as this viewer may see them.
export async function taskActivity(request, env, me) {
  if (!signedIn(me)) return [];
  const tasks = new Map((await listTasks(request, env, me)).map((t) => [t.number, t]));
  if (!tasks.size) return [];
  const { results } = await env.DB.prepare(
    `SELECT e.kind, e.at, e.by_name, e.to_value, e.note, t.number FROM task_events e JOIN tasks t ON t.id = e.task_id
      WHERE e.kind = 'created' OR (e.kind = 'status' AND e.to_value IN ('done', 'dropped')) ORDER BY e.at`).all();
  return (results || []).filter((e) => tasks.has(e.number)).map((e) => ({
    at: e.at, by: e.by_name, task: tasks.get(e.number),
    what: e.kind === 'created' ? 'created' : e.to_value, note: e.note || null,
  }));
}

// Notifications: tasks assigned to this person (or a group they are in), and
// tasks from a question they answered that are now Done — which is the loop
// closing for the person who gave the answer.
export async function taskNotifications(request, env, me, since) {
  if (!tasksOn(env) || !signedIn(me)) return [];
  const items = [];
  const tasks = await listTasks(request, env, me);
  const assigned = tasks.filter((t) => t.assignee?.mine && !CLOSED.has(t.status));
  if (assigned.length) {
    items.push({
      kind: 'tasks', forYou: true, count: assigned.length, href: '/tasks/?mine=1',
      unseen: assigned.filter((t) => t.updated_at > since).length,
      text: `${assigned.length} task${assigned.length === 1 ? '' : 's'} assigned to you`,
      detail: assigned.slice(0, 3).map((t) => `${t.ref} ${t.title}`).join(' · '),
    });
  }
  const { results } = await env.DB.prepare('SELECT DISTINCT question_id FROM answers WHERE author_sub = ?').bind(me.sub).all();
  const answered = new Set((results || []).map((r) => r.question_id));
  if (answered.size) {
    const ids = new Set([...answered]);
    const questions = (await viewerCtx(request, env, me)).m.questions.filter((q) => ids.has(q.id));
    const qn = new Set(questions.map((q) => q.number));
    for (const t of tasks) {
      if (t.status !== 'done' || !t.source.question || !qn.has(t.source.question.number) || !(t.closed_at > since)) continue;
      const closing = (await readTask(request, env, me, t.number))?.events.filter((e) => e.kind === 'status').pop();
      items.push({
        kind: 'task-done', forYou: true, count: 1, unseen: 1, href: t.href,
        text: `${t.ref} is done: ${t.title} (from Q${t.source.question.number}, which you answered)`,
        detail: closing?.note || null,
      });
    }
  }
  return items;
}

// --- pages ----------------------------------------------------------------------

const para = (text) => String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
const day = (at) => String(at || '').slice(0, 10);
const statusTag = (t) => `<span class="task-status">${esc(t.status_label)}</span>`;
const sourceLink = (s) => (s.href ? `<a href="${esc(s.href)}">${esc(s.label)}</a>` : esc(s.label));
const who = (t) => (t.assignee ? `${esc(t.assignee.name)}${t.assignee.kind === 'group' ? ' (group)' : ''}` : 'nobody yet');

// "Tasks: T1 Open · T3 Done", for a question's card and its margin aside.
export function questionTasksLine(tasks) {
  if (!tasks?.length) return '';
  return `<p class="q-tasks">Tasks: ${tasks.map((t) => `<a href="${esc(t.href)}">${esc(t.ref)}</a> ${statusTag(t)}`).join(' · ')}</p>`;
}

// The questions page and the margin: chips, and "Make a task" for an editor.
export const makeTaskHref = (q) => `/tasks/new?source_kind=question&amp;source_ref=Q${q.number}`;

function taskRow(t) {
  return `<article class="card task-card" id="${esc(t.ref)}" data-status="${esc(t.status)}">
<p class="counts"><a href="${esc(t.href)}">${esc(t.ref)}</a> · ${statusTag(t)} · for ${who(t)} · from ${sourceLink(t.source)}</p>
<p><a href="${esc(t.href)}"><strong>${esc(t.title)}</strong></a></p></article>`;
}

export function tasksListPage(tasks, { me, filters }) {
  const f = filters || {};
  const want = STATUSES.some((s) => s.key === f.status) ? f.status : null;
  const nav = [
    `<a class="filter" href="/tasks/" aria-pressed="${!want && !f.mine ? 'true' : 'false'}">All</a>`,
    `<a class="filter" href="/tasks/?mine=1" aria-pressed="${f.mine ? 'true' : 'false'}">Mine</a>`,
    ...STATUSES.map((s) => `<a class="filter" href="/tasks/?status=${s.key}" aria-pressed="${want === s.key ? 'true' : 'false'}">${esc(s.label)}</a>`),
  ].join('');
  const groups = STATUSES.map((s) => ({ ...s, tasks: tasks.filter((t) => t.status === s.key) })).filter((g) => g.tasks.length);
  return `<h1>Tasks</h1>
<p class="lede">The work this project’s questions and decisions created, and who is doing it.${f.question ? ` From ${esc(f.question)} only.` : ''}</p>
<nav class="filters" aria-label="Filter tasks">${nav}</nav>
${isEditor(me) ? '<p><a class="btn" href="/tasks/new">New task</a></p>' : ''}
${groups.length ? groups.map((g) => `<h2 id="status-${g.key}">${esc(g.label)}</h2>
<div class="cards">
${g.tasks.map(taskRow).join('\n')}
</div>`).join('\n') : '<p class="muted">No tasks here yet.</p>'}`;
}

function assigneeOptions(selected, groups, people) {
  const opt = (value, label) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  return [opt('', 'Nobody yet'),
    ...groups.map((g) => opt(`group:${g.id}`, `${g.name} (group)`)),
    ...people.filter((p) => !p.disabled).map((p) => opt(`person:${p.email}`, p.name))].join('');
}

// The form value of a task's assignee, read for an EDITOR's form only: a
// person's is their address, which no shape sends (the people menu already
// lists addresses to editors, and only to them).
async function assigneeValue(env, n) {
  const r = await env.DB.prepare('SELECT assignee_kind, assignee FROM tasks WHERE number = ?').bind(numberOf(n)).first();
  return r?.assignee_kind ? `${r.assignee_kind}:${r.assignee}` : '';
}

const errorBox = (error) => (error ? `<p class="note" role="alert">${esc(error)}</p>` : '');

export function taskPage(t, { me, groups, people, error, assigned = '' }) {
  const events = t.events.map((e) => {
    const what = e.kind === 'created' ? `made it, as ${esc(e.to)}`
      : e.kind === 'status' ? `moved it from ${esc(e.from)} to ${esc(e.to)}`
        : e.kind === 'assignee' ? (e.to ? `gave it to ${esc(e.to)}` : 'took it off its assignee')
          : e.kind === 'edit' ? `edited the ${esc(e.note)}`
            : e.kind === 'link' ? (e.to ? `linked ${esc(e.to)}` : `unlinked ${esc(e.from)}`) : 'said';
    const note = e.note && e.kind !== 'edit' ? para(e.note) : '';
    return `<li class="task-event" data-kind="${esc(e.kind)}"><p class="counts">${esc(day(e.at))} · ${esc(e.by)} ${what}</p>${note}</li>`;
  }).join('\n');
  const links = t.links.length ? `<ul class="task-links">${t.links.map((l) => `<li>${esc(l.label)}: ${l.href
    ? `<a href="${esc(l.href)}" rel="noreferrer" target="_blank">${esc(l.ref)} ↗</a>` : esc(l.ref)}</li>`).join('')}</ul>` : '';
  const edit = isEditor(me) ? `<h2 id="update">Update</h2>
<form class="form task-form" method="post" action="${esc(t.href)}">
  <input type="hidden" name="base_updated_at" value="${esc(t.updated_at)}">
  <label for="t-status">Status</label>
  <select id="t-status" name="status">${FLOW.map((s) => `<option value="${s}"${s === t.status ? ' selected' : ''}>${esc(LABEL[s])}</option>`).join('')}</select>
  <label for="t-assignee">For</label>
  <select id="t-assignee" name="assignee">${assigneeOptions(assigned, groups, people)}</select>
  <label for="t-note">Note</label>
  <textarea id="t-note" name="note" rows="3" placeholder="What was done, or why. Needed to close a task."></textarea>
  <label for="t-link-kind">Add a link</label>
  <input id="t-link-kind" name="link_kind" placeholder="kind, e.g. hub or pr" size="10">
  <input name="link_ref" placeholder="id or number" size="14" aria-label="Link reference">
  <input name="link_url" placeholder="https://… (optional)" size="30" aria-label="Link URL">
  <button class="btn primary" type="submit">Save</button>
</form>` : '';
  return `<h1><span class="task-ref">${esc(t.ref)}</span> ${esc(t.title)}</h1>
${errorBox(error)}
<p class="counts">${statusTag(t)} · for ${who(t)} · from ${sourceLink(t.source)} · made by ${esc(t.created_by)} on ${esc(day(t.created_at))}${t.closed_at ? ` · closed ${esc(day(t.closed_at))}` : ''}</p>
${para(t.body)}
${links}
<h2 id="history">History and comments</h2>
<ol class="task-events">
${events}
</ol>
<form class="form task-comment" method="post" action="${esc(t.href)}comment">
  <label for="t-comment">Comment</label>
  <textarea id="t-comment" name="body" rows="3" required></textarea>
  <button class="btn" type="submit">Comment</button>
</form>
${edit}`;
}

export function newTaskPage(prefill, { groups, people, error }) {
  const p = prefill || {};
  const v = (k) => esc(p[k] ?? '');
  return `<h1>New task</h1>
${errorBox(error)}
<form class="form task-form" method="post" action="/tasks/new">
  <label for="n-title">Title</label>
  <input id="n-title" name="title" value="${v('title')}" required maxlength="${MAX_TITLE}">
  <label for="n-body">What it is</label>
  <textarea id="n-body" name="body" rows="5">${v('body')}</textarea>
  <label for="n-kind">Came from</label>
  <select id="n-kind" name="source_kind">${SOURCE_KINDS.map((k) => `<option value="${k}"${k === (p.source_kind || 'request') ? ' selected' : ''}>${k}</option>`).join('')}</select>
  <input name="source_ref" value="${v('source_ref')}" placeholder="Q4, an answer or comment id, doc#anchor, or a note" aria-label="Source reference">
  <input name="anchor" value="${v('anchor')}" placeholder="#decision-anchor (optional)" aria-label="Decision anchor">
  <label for="n-status">Status</label>
  <select id="n-status" name="status">${FLOW.filter((s) => !CLOSED.has(s)).map((s) => `<option value="${s}"${s === (p.status || 'open') ? ' selected' : ''}>${esc(LABEL[s])}</option>`).join('')}</select>
  <label for="n-assignee">For</label>
  <select id="n-assignee" name="assignee">${assigneeOptions(p.assignee || '', groups, people)}</select>
  <label for="n-link-kind">Link</label>
  <input id="n-link-kind" name="link_kind" value="${v('link_kind')}" placeholder="kind, e.g. hub" size="10">
  <input name="link_ref" value="${v('link_ref')}" placeholder="id" size="14" aria-label="Link reference">
  <input name="link_url" value="${v('link_url')}" placeholder="https://… (optional)" size="30" aria-label="Link URL">
  <button class="btn primary" type="submit">Make the task</button>
</form>`;
}

const assigneeFromForm = (v) => {
  const s = String(v || '');
  if (!s) return null;
  const i = s.indexOf(':');
  return i > 0 ? { kind: s.slice(0, i), key: s.slice(i + 1) } : null;
};
const hasLink = (f) => !!(f.get('link_kind') || f.get('link_ref') || f.get('link_url'));
const linkFromForm = (f) => (hasLink(f)
  ? [{ kind: String(f.get('link_kind') || '').trim(), ref: String(f.get('link_ref') || '').trim(), url: String(f.get('link_url') || '').trim() || undefined }]
  : []);

// /tasks/... for the band layout. `render(title, body, extra)` is the layout.
// Returns a Response, or null when this is not a task path.
export async function taskPages(request, env, me, url, render, status = (s) => s) {
  const p = url.pathname;
  if (!tasksOn(env) || !(p === '/tasks' || p.startsWith('/tasks/'))) return null;
  const redirect = (to, code = 302) => new Response(null, { status: code, headers: { location: to, 'cache-control': 'no-store' } });
  if (!signedIn(me)) return redirect(`/auth/login?next=${encodeURIComponent(p + url.search)}`);
  if (p === '/tasks') return redirect('/tasks/', 301);
  const crumb = { href: '/tasks/', label: 'Tasks' };
  const ctx = await viewerCtx(request, env, me);
  const groups = declaredGroups(ctx.m);
  const people = isEditor(me) ? await listPeople(env).catch(() => []) : [];
  const page = (title, body, code = 200, extra = {}) => status(render(title, body, extra), code);

  if (request.method === 'POST') {
    // ⚠️ A form post must come from this site. The session cookie is
    // SameSite=Lax, which already keeps it off another site's POST; this
    // refuses one that arrives some other way with a foreign Origin.
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return page('Refused', '<h1>Refused</h1><p>That form was not sent from this site.</p>', 403);
    const f = await request.formData().catch(() => new FormData());

    if (p === '/tasks/new') {
      const input = {
        title: f.get('title'), body: f.get('body'), status: f.get('status') || 'open',
        source: { kind: f.get('source_kind') || 'request', ref: f.get('source_ref'), anchor: f.get('anchor') || undefined },
        assignee: assigneeFromForm(f.get('assignee')), links: linkFromForm(f),
      };
      const r = await createTask(input, request, env, me);
      if (r.ok) return redirect(r.task.href, 303);
      return page('New task', newTaskPage(Object.fromEntries(f), { groups, people, error: r.error }), r.status, { crumb });
    }
    const mComment = p.match(/^\/tasks\/(T\d+)\/comment$/i);
    if (mComment) {
      const r = await commentOnTask(mComment[1], f.get('body'), request, env, me);
      if (r.ok) return redirect(`/tasks/${mComment[1].toUpperCase()}/#history`, 303);
      return page('Not posted', `<h1>Not posted</h1>${errorBox(r.error)}<p><a href="/tasks/${esc(mComment[1])}/">Back to the task</a></p>`, r.status, { crumb });
    }
    const mTask = p.match(/^\/tasks\/(T\d+)\/$/i);
    if (mTask) {
      const current = await readTask(request, env, me, mTask[1]);
      const assigned = isEditor(me) ? await assigneeValue(env, mTask[1]) : '';
      const a = String(f.get('assignee') ?? '');
      const input = {
        base_updated_at: f.get('base_updated_at'), status: f.get('status') || undefined, note: f.get('note'),
        ...(f.has('assignee') && a !== assigned ? { assignee: assigneeFromForm(a) } : {}),
        ...(hasLink(f) ? { add_links: linkFromForm(f) } : {}),
      };
      const r = await updateTask(mTask[1], input, request, env, me);
      if (r.ok) return redirect(r.task.href, 303);
      if (!current) return null;
      return page(current.title, taskPage(current, { me, groups, people, error: r.error, assigned }), r.status, { crumb });
    }
    return null;
  }

  if (p === '/tasks/') {
    const filters = { status: url.searchParams.get('status') || null, mine: url.searchParams.get('mine') === '1', question: url.searchParams.get('question') || null };
    return page('Tasks', tasksListPage(await listTasks(request, env, me, filters), { me, filters }));
  }
  if (p === '/tasks/new' || p === '/tasks/new/') {
    if (!isEditor(me)) return page('Tasks', '<h1>Only editors make tasks</h1><p>Ask an admin or a contributor on this project, or leave a comment where the work came from.</p>', 403, { crumb });
    const prefill = Object.fromEntries(['title', 'source_kind', 'source_ref', 'anchor', 'assignee'].map((k) => [k, url.searchParams.get(k) || '']));
    return page('New task', newTaskPage(prefill, { groups, people }), 200, { crumb });
  }
  const m = p.match(/^\/tasks\/(T\d+)\/?$/i);
  if (m) {
    if (!p.endsWith('/') || m[1] !== m[1].toUpperCase()) return redirect(`/tasks/${m[1].toUpperCase()}/`, 301);
    const t = await readTask(request, env, me, m[1]);
    if (!t) return null;
    const assigned = isEditor(me) ? await assigneeValue(env, m[1]) : '';
    return page(`${t.ref} ${t.title}`, taskPage(t, { me, groups, people, assigned }), 200, { crumb });
  }
  return null;
}
