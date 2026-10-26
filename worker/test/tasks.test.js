// Tasks (tasks.enabled; v1.13.0; worker/src/tasks.js).
//
// The work a question, an answer, a decision or a request creates, kept on the
// site so the people who answered can see what is being done about it.
// ⚠️ Most of these assert what somebody CANNOT do or see: a task from a document
// a viewer may not read must not reach them by any door, a number must never be
// handed out twice, and a site that has not turned tasks on must not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../src/index.js';
import { settingsProblems } from '../src/settings.js';
import { bandEnv, sampleVersion, get, send, ADMIN, EDITOR, READER } from './fixture.js';

const ON = { enabled: true, link_kinds: { hub: { label: 'Hub', url: 'https://hub.example.org/tasks/{ref}' } } };
const on = (opts = {}) => bandEnv({ tasks: ON, ...opts });
const call = (env, req) => worker.fetch(req, env);
const jsonOf = async (r) => ({ status: r.status, body: await r.json() });
const create = (env, who, body) => call(env, send('POST', '/api/tasks', who, body)).then(jsonOf);
const patch = (env, who, n, body) => call(env, send('PATCH', `/api/tasks/${n}`, who, body)).then(jsonOf);
const readTask = (env, who, n) => call(env, get(`/api/tasks/${n}`, who)).then(jsonOf);
const list = (env, who, q = '') => call(env, get(`/api/tasks${q}`, who)).then(jsonOf);
const page = async (env, p, who) => { const r = await call(env, get(p, who)); return { r, body: await r.text() }; };
const form = (p, who, fields, origin = 'https://collab.test') => get(p, who, {
  method: 'POST', body: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin } });
const mcp = async (env, who, name, args = {}) => {
  const r = await call(env, send('POST', '/mcp', who, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  return (await r.json()).result.content[0].text;
};
const notes = (env, who) => call(env, get('/api/notifications', who)).then((r) => r.json());
const Q1 = { kind: 'question', ref: 'Q1' };

// --- off by default --------------------------------------------------------------

test('off by default: no route, no page, no tool, no Tools link', async () => {
  const env = await bandEnv();
  assert.equal((await call(env, get('/api/tasks', ADMIN))).status, 404);
  assert.equal((await call(env, send('POST', '/api/tasks', ADMIN, { title: 'x', source: Q1 }))).status, 404);
  assert.equal((await call(env, get('/tasks/', ADMIN))).status, 404);
  const home = (await page(env, '/', ADMIN)).body;
  assert.ok(!home.includes('href="/tasks/"'), 'the Tools box links to tasks while they are off');
  const tools = await call(env, send('POST', '/mcp', ADMIN, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).then((r) => r.json());
  assert.ok(!tools.result.tools.some((t) => /task/.test(t.name)), 'the MCP lists a task tool while tasks are off');
});

test('settings: tasks need the band layout, and a link kind needs an http(s) URL with {ref}', () => {
  assert.deepEqual(settingsProblems({ site: { layout: 'band' }, tasks: { enabled: true } }), []);
  assert.match(settingsProblems({ tasks: { enabled: true } }).join(), /needs site\.layout: band/);
  assert.match(settingsProblems({ site: { layout: 'band' }, tasks: { enabled: 'yes' } }).join(), /true or false/);
  assert.match(settingsProblems({ site: { layout: 'band' }, tasks: { link_kinds: { hub: { url: 'javascript:alert(1)//{ref}' } } } }).join(), /http\(s\) URL containing \{ref\}/);
  assert.match(settingsProblems({ site: { layout: 'band' }, tasks: { link_kinds: { hub: { url: 'https://x.org/t' } } } }).join(), /containing \{ref\}/);
});

// --- who may write, who may read ---------------------------------------------

test('only editors create: a reader is refused, a stranger is refused', async () => {
  const env = await on({ publicRead: true });
  assert.equal((await create(env, READER, { title: 'x', source: Q1 })).status, 403);
  assert.equal((await create(env, null, { title: 'x', source: Q1 })).status, 401);
  const ok = await create(env, EDITOR, { title: 'Rename curator to guide', source: Q1 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.task.number, 1);
  assert.equal(ok.body.task.ref, 'T1');
});

test('an editor’s agent token creates as that editor; a reader’s does not', async () => {
  const env = await on();
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  env.AGENT_TOKENS = JSON.stringify({ [EDITOR]: `sha256:${hash('tok-editor')}`, [READER]: `sha256:${hash('tok-reader')}` });
  const as = (tok, body) => call(env, new Request('https://collab.test/api/tasks', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` } })).then(jsonOf);
  const ok = await as('tok-editor', { title: 'From an agent', source: Q1 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.task.created_by, 'editor');
  assert.equal((await as('tok-reader', { title: 'x', source: Q1 })).status, 403);
});

test('tasks are for signed-in people only, even on a public site', async () => {
  const env = await on({ publicRead: true });
  await create(env, EDITOR, { title: 'A task', source: Q1 });
  assert.equal((await list(env, null)).status, 401);
  assert.equal((await readTask(env, null, 1)).status, 401);
  const r = await call(env, get('/tasks/', null));
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/auth\/login\?next=%2Ftasks%2F$/);
  assert.equal((await list(env, READER)).body.tasks.length, 1, 'a signed-in reader sees it');
});

test('a task from a document the viewer cannot see is not theirs to see, by any door', async () => {
  const v = sampleVersion();
  v.statuses = { plan: 'draft' };   // only editors see the plan, and its questions
  const env = await on({ version: v });
  const t = await create(env, EDITOR, { title: 'SECRET-TASK', body: 'SECRET-BODY', source: Q1, assignee: { kind: 'group', key: 'reviewers' } });
  assert.equal(t.status, 201);
  await create(env, EDITOR, { title: 'Open to all', source: { kind: 'request', ref: 'asked in chat' } });

  assert.deepEqual((await list(env, READER)).body.tasks.map((x) => x.title), ['Open to all']);
  assert.equal((await readTask(env, READER, 1)).status, 404);
  for (const p of ['/tasks/', '/tasks/T1/', '/activity/?type=tasks', '/activity/']) {
    const { body } = await page(env, p, READER);
    assert.ok(!body.includes('SECRET'), `${p} shows the hidden task to a reader`);
  }
  assert.match(await mcp(env, READER, 'read_task', { number: 1 }), /No such task/);
  assert.ok(!(await mcp(env, READER, 'list_tasks')).includes('SECRET'));
  assert.ok(!JSON.stringify(await notes(env, READER)).includes('SECRET'), 'a notification names the hidden task');
  // ...and the editor, who can see the plan, sees all of it.
  assert.equal((await list(env, EDITOR)).body.tasks.length, 2);
  assert.match((await page(env, '/tasks/T1/', EDITOR)).body, /SECRET-TASK/);
});

// --- numbers ---------------------------------------------------------------

test('a T-number is never handed out twice: not after a drop, not in a race', async () => {
  const env = await on();
  const a = await create(env, EDITOR, { title: 'one', source: Q1 });
  const dropped = await patch(env, EDITOR, 1, { status: 'dropped', note: 'not needed', base_updated_at: a.body.task.updated_at });
  assert.equal(dropped.status, 200);
  assert.equal((await create(env, EDITOR, { title: 'two', source: Q1 })).body.task.number, 2);
  const race = await Promise.all([create(env, EDITOR, { title: 'r1', source: Q1 }), create(env, EDITOR, { title: 'r2', source: Q1 })]);
  assert.deepEqual(race.map((x) => x.body.task.number).sort(), [3, 4]);
  assert.equal((await readTask(env, EDITOR, 1)).body.task.status, 'dropped', 'a dropped task is still there');
});

// --- sources ---------------------------------------------------------------

test('the source must exist and be visible to whoever creates the task', async () => {
  const env = await on();
  assert.equal((await create(env, EDITOR, { title: 'x', source: { kind: 'question', ref: 'Q99' } })).status, 400);
  assert.equal((await create(env, EDITOR, { title: 'x', source: { kind: 'answer', ref: 'no-such-answer' } })).status, 400);
  assert.equal((await create(env, EDITOR, { title: 'x', source: { kind: 'comment', ref: 'no-such-comment' } })).status, 400);
  assert.equal((await create(env, EDITOR, { title: 'x', source: { kind: 'decision', ref: 'plan#no-such-anchor' } })).status, 400);
  assert.equal((await create(env, EDITOR, { title: 'x', source: { kind: 'nonsense' } })).status, 400);
  assert.equal((await create(env, EDITOR, { title: '', source: Q1 })).status, 400, 'a task needs a title');

  const d = await create(env, EDITOR, { title: 'x', source: { kind: 'decision', ref: 'plan#measure' } });
  assert.equal(d.status, 201);
  assert.equal(d.body.task.source.href, '/plan/#measure');

  await call(env, send('POST', '/api/answers', READER, { question_id: 'sample:first-audience', body: 'The team first.' }));
  const ans = (await env.DB.prepare('SELECT id FROM answers').first()).id;
  const fromAnswer = await create(env, EDITOR, { title: 'y', source: { kind: 'answer', ref: ans } });
  assert.equal(fromAnswer.status, 201);
  assert.equal(fromAnswer.body.task.source.question.number, 1, 'an answer’s task belongs to its question');
});

test('a task made from a question links back to it, and the question lists it', async () => {
  const env = await on();
  const t = await create(env, EDITOR, { title: 'Settings page per guide', source: Q1 });
  assert.equal(t.body.task.source.question.number, 1);
  assert.equal(t.body.task.source.href, '/questions/#q1');
  const qs = (await page(env, '/questions/', READER)).body;
  assert.match(qs, /<p class="q-tasks">Tasks: <a href="\/tasks\/T1\/">T1<\/a> <span class="task-status">Open<\/span><\/p>/);
  const doc = (await page(env, '/plan/', READER)).body;
  assert.match(doc, /<p class="q-tasks">Tasks: <a href="\/tasks\/T1\/">T1<\/a>/, 'the margin question lists its task too');
  const one = (await page(env, '/tasks/T1/', READER)).body;
  assert.match(one, /href="\/questions\/#q1">Q1<\/a>/);
});

// --- updates ---------------------------------------------------------------

test('Done and Dropped need a closing note; a stale update is refused', async () => {
  const env = await on();
  const t = (await create(env, EDITOR, { title: 'x', source: Q1 })).body.task;
  assert.equal((await patch(env, EDITOR, 1, { status: 'done', base_updated_at: t.updated_at })).status, 400);
  assert.equal((await patch(env, EDITOR, 1, { status: 'dropped', note: '  ', base_updated_at: t.updated_at })).status, 400);
  assert.equal((await patch(env, EDITOR, 1, { status: 'review' })).status, 409, 'an update that names no base is refused');
  assert.equal((await patch(env, EDITOR, 1, { status: 'review', base_updated_at: '2000-01-01T00:00:00.000Z' })).status, 409);
  assert.equal((await patch(env, READER, 1, { status: 'review', base_updated_at: t.updated_at })).status, 403);
  const done = await patch(env, EDITOR, 1, { status: 'done', note: 'Shipped in v1.13.0', base_updated_at: t.updated_at });
  assert.equal(done.status, 200);
  assert.ok(done.body.task.closed_at);
  const events = (await readTask(env, READER, 1)).body.task.events;
  assert.deepEqual(events.map((e) => e.kind), ['created', 'status']);
  assert.equal(events[1].note, 'Shipped in v1.13.0');
  assert.equal(events[1].by, 'editor');
  assert.ok(!JSON.stringify(events).includes('@'), 'an event carries an email address');
});

test('assignees: a declared group or a person on the roster, shown by name, never by address', async () => {
  const env = await on();
  assert.equal((await create(env, EDITOR, { title: 'x', source: Q1, assignee: { kind: 'group', key: 'nobody' } })).status, 400);
  assert.equal((await create(env, EDITOR, { title: 'x', source: Q1, assignee: { kind: 'person', key: 'ghost@example.org' } })).status, 400);
  const t = await create(env, EDITOR, { title: 'x', source: Q1, assignee: { kind: 'person', key: READER } });
  assert.equal(t.status, 201);
  assert.deepEqual(t.body.task.assignee, { kind: 'person', name: 'reader', mine: false });
  assert.equal((await readTask(env, READER, 1)).body.task.assignee.mine, true);
  assert.ok(!JSON.stringify((await list(env, ADMIN)).body).includes(READER), 'the list carries an email address');
});

test('links: a configured kind renders through its pattern; a script URL never renders', async () => {
  const env = await on();
  const t = await create(env, EDITOR, { title: 'x', source: Q1, links: [
    { kind: 'hub', ref: 'abc 123' }, { kind: 'pr', ref: '#42', url: 'https://github.com/o/r/pull/42' },
    { kind: 'bad', ref: 'x', url: 'javascript:alert(1)' }] });
  assert.equal(t.status, 400, 'a javascript: link is refused');
  const ok = await create(env, EDITOR, { title: 'x', source: Q1, links: [
    { kind: 'hub', ref: 'abc 123' }, { kind: 'pr', ref: '#42', url: 'https://github.com/o/r/pull/42' }] });
  assert.deepEqual(ok.body.task.links.map((l) => l.href), ['https://hub.example.org/tasks/abc%20123', 'https://github.com/o/r/pull/42']);
  assert.equal(ok.body.task.links[0].label, 'Hub');
});

// --- pages -------------------------------------------------------------------

test('pages: the list and the task escape what people typed', async () => {
  const env = await on();
  await create(env, EDITOR, { title: '<script>alert(1)</script>', body: '<img src=x onerror=alert(1)>', source: Q1 });
  for (const p of ['/tasks/', '/tasks/T1/']) {
    const { r, body } = await page(env, p, READER);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(!body.includes('<script>alert(1)'), `${p} renders a title as markup`);
    assert.ok(!body.includes('<img src=x'), `${p} renders a body as markup`);
  }
  assert.equal((await call(env, get('/tasks/T99/', READER))).status, 404);
  assert.match((await page(env, '/', READER)).body, /class="tool" href="\/tasks\/"/, 'the Tools box links to tasks');
});

test('forms: an editor creates and closes a task with no script; a reader comments', async () => {
  const env = await on();
  const made = await call(env, form('/tasks/new', EDITOR, { title: 'From the form', source_kind: 'question', source_ref: 'Q1' }));
  assert.equal(made.status, 303);
  assert.equal(made.headers.get('location'), '/tasks/T1/');
  assert.equal((await call(env, form('/tasks/new', READER, { title: 'x', source_kind: 'question', source_ref: 'Q1' }))).status, 403);
  assert.equal((await call(env, form('/tasks/new', EDITOR, { title: 'x', source_kind: 'question', source_ref: 'Q1' }, 'https://evil.example'))).status, 403,
    'a form posted from another origin is refused');
  const t = (await readTask(env, EDITOR, 1)).body.task;
  const closed = await call(env, form('/tasks/T1/', EDITOR, { status: 'done', note: 'Done here', base_updated_at: t.updated_at }));
  assert.equal(closed.status, 303);
  assert.equal((await readTask(env, EDITOR, 1)).body.task.status, 'done');
  const said = await call(env, form('/tasks/T1/comment', READER, { body: 'Thanks, that answers it.' }));
  assert.equal(said.status, 303);
  assert.match((await page(env, '/tasks/T1/', ADMIN)).body, /Thanks, that answers it\./);
  const newPage = (await page(env, '/tasks/new?source_kind=question&source_ref=Q1', EDITOR)).body;
  assert.match(newPage, /name="source_ref" value="Q1"/, 'Make a task carries the question');
  assert.match((await page(env, '/questions/', EDITOR)).body, /href="\/tasks\/new\?source_kind=question&amp;source_ref=Q1"/, 'an editor sees Make a task');
  assert.ok(!(await page(env, '/questions/', READER)).body.includes('/tasks/new'), 'a reader does not');
});

test('Activity lists a task made and a task closed, with its note', async () => {
  const env = await on();
  const t = (await create(env, EDITOR, { title: 'Rename curator', source: Q1 })).body.task;
  await patch(env, EDITOR, 1, { status: 'done', note: 'Renamed everywhere', base_updated_at: t.updated_at });
  const { body } = await page(env, '/activity/?type=tasks', READER);
  assert.match(body, /T1<\/a> made from <a href="\/questions\/#q1">Q1<\/a>/);
  assert.match(body, /T1<\/a> Done: Renamed everywhere/);
  assert.match(body, /aria-pressed="true">Tasks</);
});

// --- notifications -----------------------------------------------------------

test('assigned to you: a person, or a group they are in', async () => {
  const env = await on();
  await create(env, EDITOR, { title: 'For the reviewers', source: Q1, assignee: { kind: 'group', key: 'reviewers' } });
  await create(env, EDITOR, { title: 'For the admin', source: Q1, assignee: { kind: 'person', key: ADMIN } });
  const r = (await notes(env, READER)).items.find((i) => i.kind === 'tasks');
  assert.equal(r.count, 1);
  assert.equal(r.href, '/tasks/?mine=1');
  const a = (await notes(env, ADMIN)).items.find((i) => i.kind === 'tasks');
  assert.equal(a.count, 1);
  assert.deepEqual((await list(env, READER, '?mine=1')).body.tasks.map((x) => x.title), ['For the reviewers']);
});

test('the loop closes: when a task from a question is Done, everyone who answered it is told', async () => {
  const env = await on();
  await call(env, send('POST', '/api/answers', READER, { question_id: 'sample:first-audience', body: 'The team first.' }));
  const t = (await create(env, EDITOR, { title: 'Act on Q1', source: Q1 })).body.task;
  assert.ok(!(await notes(env, READER)).items.some((i) => i.kind === 'task-done'), 'told before it is done');
  await patch(env, EDITOR, 1, { status: 'done', note: 'Acted on', base_updated_at: t.updated_at });
  const done = (await notes(env, READER)).items.find((i) => i.kind === 'task-done');
  assert.ok(done, 'the answerer is not told');
  assert.match(done.text, /T1 is done/);
  assert.equal(done.unseen, 1);
  assert.ok(!(await notes(env, ADMIN)).items.some((i) => i.kind === 'task-done'), 'somebody who did not answer is told');
});

// --- MCP -------------------------------------------------------------------------

test('MCP: the four tools, the same rules', async () => {
  const env = await on();
  const tools = await call(env, send('POST', '/mcp', READER, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).then((r) => r.json());
  for (const n of ['list_tasks', 'read_task', 'create_task', 'update_task']) assert.ok(tools.result.tools.some((t) => t.name === n), n);
  assert.match(await mcp(env, READER, 'create_task', { title: 'x', source: Q1 }), /Not permitted/);
  assert.match(await mcp(env, EDITOR, 'create_task', { title: 'Via MCP', source: Q1 }), /Created T1/);
  const read = JSON.parse(await mcp(env, READER, 'read_task', { number: 1 }));
  assert.equal(read.title, 'Via MCP');
  assert.match(await mcp(env, EDITOR, 'update_task', { number: 1, status: 'done', base_updated_at: read.updated_at }), /closing note/);
  assert.match(await mcp(env, EDITOR, 'update_task', { number: 1, status: 'done', note: 'ok', base_updated_at: read.updated_at }), /T1 is now Done/);
  assert.equal(JSON.parse(await mcp(env, READER, 'list_tasks', { status: 'done' })).length, 1);
});

test('a task ties to a GitHub pull request by either spelling, and is found by it', async () => {
  const env = await on();
  const a = await create(env, EDITOR, { title: 'Settings page', source: Q1, links: [{ kind: 'pr', ref: 'sarapis/collab-template#21' }] });
  assert.equal(a.status, 201);
  assert.deepEqual(a.body.task.links, [{ kind: 'pr', ref: 'sarapis/collab-template#21', label: 'PR', href: 'https://github.com/sarapis/collab-template/pull/21' }]);
  // A pasted URL, with no kind, is the same PR.
  const b = await create(env, EDITOR, { title: 'Other', source: Q1, links: [{ url: 'https://github.com/sarapis/ctfg-collab/pull/7/files' }] });
  assert.equal(b.body.task.links[0].ref, 'sarapis/ctfg-collab#7');
  assert.equal((await create(env, EDITOR, { title: 'x', source: Q1, links: [{ kind: 'pr', ref: '#42' }] })).status, 400, 'a PR with no repo');
  // Found by the PR, whichever way it is written.
  for (const q of ['sarapis/collab-template#21', 'https://github.com/sarapis/collab-template/pull/21']) {
    assert.deepEqual((await list(env, READER, `?pr=${encodeURIComponent(q)}`)).body.tasks.map((t) => t.ref), ['T1'], q);
  }
  assert.equal(JSON.parse(await mcp(env, READER, 'list_tasks', { pr: 'https://github.com/sarapis/ctfg-collab/pull/7' }))[0].ref, 'T2');
  // Linked later, from the task page's form, by pasting the URL.
  const t = (await readTask(env, EDITOR, 2)).body.task;
  await call(env, form('/tasks/T2/', EDITOR, { base_updated_at: t.updated_at, status: t.status, link_url: 'https://github.com/sarapis/ctfg-collab/pull/8' }));
  assert.deepEqual((await readTask(env, READER, 2)).body.task.links.map((l) => l.ref), ['sarapis/ctfg-collab#7', 'sarapis/ctfg-collab#8']);
  assert.match((await page(env, '/tasks/T2/', READER)).body, /PR: <a href="https:\/\/github\.com\/sarapis\/ctfg-collab\/pull\/8" rel="noreferrer" target="_blank">sarapis\/ctfg-collab#8 ↗<\/a>/);
});

test('saving the task form keeps an assignee who has since been disabled', async () => {
  // The form lists only people who can be chosen today. A task's current
  // assignee must stay in it anyway, or the browser sends "Nobody yet" and a
  // note-only save takes the task off them.
  const env = await on();
  const t = (await create(env, EDITOR, { title: 'x', source: Q1, assignee: { kind: 'person', key: READER } })).body.task;
  await env.DB.prepare('UPDATE users SET disabled_at = ? WHERE email = ?').bind(new Date().toISOString(), READER).run();
  const html = (await page(env, '/tasks/T1/', EDITOR)).body;
  const m = html.match(/<select id="t-assignee" name="assignee">(.*?)<\/select>/s);
  const selected = m && (m[1].match(/<option value="([^"]*)" selected>/) || [])[1];
  assert.equal(selected, `person:${READER}`, 'the form no longer shows who has the task');
  await call(env, form('/tasks/T1/', EDITOR, { base_updated_at: t.updated_at, status: t.status, assignee: selected ?? '', note: 'a progress note' }));
  const after = (await readTask(env, EDITOR, 1)).body.task;
  assert.equal(after.assignee?.kind, 'person', 'a note-only save unassigned the task');
  assert.deepEqual(after.events.map((e) => e.kind), ['created', 'comment']);
});

test('saving the task form keeps a person assignee it was not asked to change', async () => {
  const env = await on();
  const t = (await create(env, EDITOR, { title: 'x', source: Q1, assignee: { kind: 'person', key: READER } })).body.task;
  const pageBody = (await page(env, '/tasks/T1/', EDITOR)).body;
  assert.match(pageBody, new RegExp(`<option value="person:${READER}" selected>`), 'the form does not show who has it');
  // The form as a browser would send it back: every field, the assignee untouched.
  await call(env, form('/tasks/T1/', EDITOR, { base_updated_at: t.updated_at, status: 'review', assignee: `person:${READER}`, note: '' }));
  const after = (await readTask(env, READER, 1)).body.task;
  assert.equal(after.status, 'review');
  assert.equal(after.assignee?.mine, true, 'saving the form dropped the assignee');
  assert.deepEqual(after.events.map((e) => e.kind), ['created', 'status']);
});
