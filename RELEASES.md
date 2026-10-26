# Releases

What each version changed, for an instance deciding whether and how to take it
(`npm run template -- update <tag>`, TEMPLATE.md).

## v1.13.2 — The deploy applies the D1 schema itself

**`.github/workflows/deploy.yml` changes: it now runs `worker/schema.sql` against
the site's D1 database (binding `DB`) before every deploy.** The CI token
(`CLOUDFLARE_API_TOKEN`) therefore needs D1 edit access as well as Workers. If it
lacks it, the deploy stops at that step and the live site is unchanged. No code,
setting or compiled output changes.

- **A schema change no longer waits on someone with a database login.** Every
  version that changed `worker/schema.sql` (v1.1.0, v1.13.0) asked each instance
  to apply it by hand, from a machine logged into the right Cloudflare account.
  Turning tasks on before that was done would break every page that lists them.
  Now the tables reach the database in the same run, and before the code that
  reads them.
- **The schema stays re-runnable by rule.** `test/schema-idempotent.test.js`
  fails if any statement in `worker/schema.sql` is not
  `CREATE … IF NOT EXISTS`, and if the deploy stops applying the schema before
  the code. A change that needs more (a new column, a backfill) is a guarded
  migration of its own, never a statement in this file.

## v1.13.1 — Saving a task never unassigns it by accident

**Take this instead of v1.13.0 if you turn tasks on.** Only `worker/src/tasks.js`
changes, plus a test. No setting, schema or compiled output changes.

- **A note-only save could unassign a task.** The task form's assignee menu
  listed only people and groups that can be chosen today, so a task assigned to
  someone since disabled (or a group since removed from the settings) rendered
  with nothing selected, and the browser submitted "Nobody yet". The current
  assignee is now always an option, marked as no longer active.

## v1.13.0 — Tasks: the work a question creates, on the site

**`worker/schema.sql` changes: it adds `tasks` and `task_events`** (both
`CREATE … IF NOT EXISTS`; apply it at deploy). **Off by default:** an instance
that does not set `tasks.enabled: true` serves byte-identical pages and answers
(measured below). The compiler and `conformance/` are unchanged, so a host that
pins only those (Databook) needs nothing.

Questions resolve into prose, but the work a decision creates had nowhere to
live on the site, so the people who answered could not see what was being done
about it. A task records that work: where it came from, who has it, where it
stands, and what was done.

- **What a task is.** It has:
  - a T-number (T1, T2 …), given out once and never reused (a task is never
    deleted; Dropped is a status);
  - a title and a body;
  - a status: Idea, Open, In Progress, Review, Done or Dropped. Done and Dropped
    need a closing note;
  - an assignee: a person on the roster, or a group (the same groups questions
    use: audiences and `to=` addressees);
  - links: `pr` is built in, as `owner/repo#12` or a pasted GitHub PR URL, both
    stored the same way. Other kinds come from `tasks.link_kinds`, e.g. a Hub id
    through a URL pattern;
  - an append-only history, with comments.
- **Where it came from:** a question (`Q4`, keeping its `resolved=` anchor), one
  answer, a decision (`doc#anchor`), a comment, a request, or something
  external. A question lists the tasks it spawned, on Questions and in the
  margin; a task links back.
- **Who:**
  - Editors (admins, contributors), and an editor's agent token, create and
    change tasks.
  - Everyone signed in reads and comments. That includes a public site: a task
    names people and carries working notes. There is no setting to open them
    yet.
  - A task follows its source: one from a document the viewer cannot see (a
    draft, a members-only page) is hidden from them at every door. One read rule
    in `worker/src/tasks.js` serves all of them.
- **Where it shows:**
  - `/tasks/` (filters: status, mine, `?question=Q4`), `/tasks/T7/`, and
    `/tasks/new`. "Make a task" on a question pre-fills its source. Every form
    works with no script, and a form posted from another origin is refused.
  - Activity gains a Tasks type: made, Done and Dropped, with the note.
  - The Tools box gains Tasks.
  - `/api/tasks` (GET, POST, GET and PATCH `/:number`, with `?pr=` to find a
    PR's task).
  - MCP gains `list_tasks`, `read_task`, `create_task` and `update_task`.
    `update_task` needs `base_updated_at`, and a stale write is refused (409).
- **Notifications, on the site only (email later):**
  - "N tasks assigned to you", for a person or their groups;
  - "T7 is done", sent to everyone who answered the question it came from. This
    closes the loop for the people who answered.
- `worker/test/d1.js` now runs a batch without yielding between statements, as
  D1 does. The old shim let two batches interleave, so the race the numbering
  must survive could not even be tested.

**Off by default, measured** against v1.12.4 on the band fixture:
- 176 answers compared (pages, API, MCP `tools/list`; anonymous, reader,
  editor, admin; public and private). 174 are byte-identical.
- The other 2 are `/api/tasks` and `/api/tasks/1` for a stranger on a private
  site: 404 before (no such route), 401 now. Every route in the table is closed
  to strangers by default.
- `_site/`, `build/`, `worker/src/site.generated.js` (`tasks` is generated only
  when configured), `packages/compile` and `conformance/` are byte-identical.
- The Worker bundle grows 167.56 → 178.93 KiB gzip.

**Instances:** take the version and apply `worker/schema.sql`. To use tasks, set
`site.layout: band` and `tasks.enabled: true` (and optionally
`tasks.link_kinds`). A classic-layout instance cannot turn them on: the build
fails with a sentence saying why.

**Not in v1.13.0:**
- due dates, priority, subtasks, a board view;
- email;
- the live status of a linked Hub task or PR;
- tasks created automatically;
- bulk edit;
- tasks in the rows content export or in git.

Tests: 471 → 499, in both the default and the band+rows variant:
- `worker/test/tasks.test.js` (20): numbering through a drop and a race; the
  read rule on every door; the write gate including agent tokens; closing notes;
  409; source and assignee validation; links and PRs; forms; Activity; both
  notifications; MCP; off by default; the task form keeping its assignee.
- The read gate now also covers the four `/api/tasks` routes.

## v1.12.4 — A retired question number is never handed out again

**Take this before adding a question if your last questions were retired.** Only
`packages/compile/src/lock.js` changes, plus a test. No setting, schema or
existing number changes; a site's build output changes only where a new
question would have taken a retired number.

- **The next number was counted from the live questions only.** When the
  highest-numbered questions were the ones retired, the next new question was
  given a retired number again: ctfg-collab had retired 46 and 47, and a new
  page's questions previewed as Q46 and Q47. That breaks the lock's one promise,
  that "Q46" in an old message still means one question, and a retired question
  that came back would then share its number. The next number now comes after
  every number ever issued, retired ones included. A lock already affected is
  not repaired by this: check `questions.lock` for a number in both `numbers`
  and `retired` before taking it.

## v1.12.3 — Security fixes from the 2026-10-21 review: comments, disabled people, rows scripts

**Take this now if your instance is public (`PUBLIC_READ=true`), runs content as
rows, or has ever disabled anyone.** Only `worker/src/` changes (`band.js`,
`chat.js`, `content.js`, `index.js`, `mcp.js`, `oauth.js`), plus tests. The
compiler, `conformance/`, `worker/schema.sql` and every setting are unchanged,
and a site's build output does not change.

- **Comments on members-only documents reached strangers.** MCP `list_comments`
  read every row unfiltered, and a reply was stored with no document and read
  as project-wide, so a reply in a members-only thread showed on `/api/comments`
  and `/activity/` to anyone. There is now one read (`band.js` `commentsFor`,
  called by `/api/comments`, MCP and Activity) that keeps only what the viewer
  may see. A new reply is stored with its parent's `doc`; one stored before
  this takes its thread's at read time, so no data needs changing.
- **Comments carried the commenter's email address** (`author_sub`), to anyone
  on a public instance. They now carry `author_name` and a `mine` flag, as
  answers do. ⚠️ MCP `list_comments` loses `author_sub` too.
- **A disabled person kept their OAuth connectors**, and their session cookie
  could still approve a new one at `/authorize`. Both doors now refuse a
  disabled row, as `identify()` already did.
- **Rows mode: a contributor's `<script>` ran for every reader, admins
  included.** Every page the Worker renders in rows mode is now sent with
  `Content-Security-Policy: script-src 'self'; object-src 'none'; base-uri 'self'`:
  no inline script, `on*=` handler or `javascript:` link runs. The layout only
  loads its own files. ⚠️ An instance whose rows content relies on an inline
  script will see it stop; move it to a file. Git-mode pages are unchanged.
- **A path that was moved away could never be used again.** Moving a document
  back, or recreating a removed path, started again at revision 1, collided
  with the history the move kept, and was reported as "somebody else saved".
  A recreated path now continues from its last revision.
- **Admins were refused the Conversation log** that only the admin menu links
  to, and never got the "fold" or "new conversation" notifications. Both now
  admit any editor (`isEditor`: admins and contributors).

Six new tests (`worker/test/band.test.js`, `rows.test.js`, `oauth.test.js`),
each failing against v1.12.2.

**Instances:** take the version (`npm run template -- update v1.12.3`). Nothing
else is needed.

Tests: 464 → 470, in both the default and the band+rows variant.

## v1.12.2 — A security fix: the sign-in page reflected `next` unescaped

**Take this now if your instance has email sign-in on** (`MAGIC_LINK_FROM`
set). **Only `worker/src/auth.js` changes, plus its tests.** The compiler,
`conformance/`, `worker/schema.sql` and every setting are unchanged, and a
site's build output does not change.

The sign-in page decoded `?next=` back into the email form's hidden input
(`value="${decodeURIComponent(next)}"`), so a crafted link such as
`/auth/login?next="><script>…</script>` ran script on the site's origin: a
reflected XSS, found by a code review on 2026-10-21. `safeNext()` already
guarded the redirect after sign-in, but the page never used it.

- `next` is now validated ONCE, with `safeNext()`, and that one value is used
  for the form, the Google/GitHub/CMS links and the redirect. Only a same-origin
  path survives: a single leading `/`, so no scheme (`javascript:`, `https:`),
  no `//`, no backslash anywhere, no control character. Anything else becomes `/`.
- It is escaped for each place it goes: `esc()` for the attribute,
  `encodeURIComponent` (then `esc()`) for the links. Nothing is decoded back
  into HTML.

`worker/test/auth.test.js` gains four tests. They load the sign-in page with
`"><script>alert(1)</script>`, `javascript:alert(1)`, `//evil.example` and
`/\evil.example` (each must fall back to `/`), a slash-led path that carries
markup (it must come back escaped), and `/docs/x?y=1` (it must round-trip
through the form and the links). They also check that a backslash anywhere, or
a control character, is refused on landing. Three of the four fail against
v1.12.1; the round-trip test passes on both, as the guard against an
over-strict fix.

**Instances:** take the version (`npm run template -- update v1.12.2`). Nothing
else is needed: a link carrying a `next` that is now refused still signs the
person in, landing on `/`.

Tests: 460 → 464, in both the default and the band+rows variant.

## v1.12.1 — `npm run new` quotes the title

**Only `scripts/new-artifact.mjs` changes, plus its new test.** The compiler,
`conformance/`, `worker/schema.sql` and every setting are unchanged; a site's
build output does not change.

The scaffold wrote the title into the front matter unquoted. A title with a
colon (`npm run new -- "The CRM and email: how it works"`) made a file the
build could not parse: comms-strat hit it on 2026-10-19 and quoted the title by
hand. Titles that look like a date, a boolean or a number (`2026-10-19`,
`true`, `1234`) parsed as one, and so did `#`, a leading `-` and `[…]`. The
title is now always written as a double-quoted YAML string. A title with no
letters or digits, which used to write `content/.md`, is refused and writes
nothing.

`test/new-artifact.test.js` runs the real script in a scratch project on nine
awkward titles, compiles each result with the real compiler, and requires the
title back unchanged and as a string. Against v1.12.0's script, 8 of its 10
tests fail.

**Instances:** nothing to do beyond taking the version. A document already
written by the old scaffold is unaffected unless its title needed quoting, in
which case its build already failed and it was fixed by hand.

Tests: 450 → 460, in both the default and the band+rows variant.

## v1.12.0 — The conformance sample states its own count, and is checked

**The compiler is unchanged; its fixtures change.** `packages/compile` is
byte-identical to v1.11.0. `worker/schema.sql` is unchanged and there are no
setting changes. An instance's own site does not change.

`conformance/sample/content/summary.md` said
`<i data-figure="counts.open">2</i>` while the sample counts 3 open questions:
"never type a count" was broken by the fixture that every host's conformance
test compiles. The template never noticed, because its figures gate reads
`content/figures.export.json` and the sample has none; Databook's figures gate (its decision 50) flags it.
The figure now says 3, and `conformance/expected/` is regenerated in this
commit: `fragments/summary.html`, that figure's `text` in `manifest.json`, and
the digest (`c51815b6…` → `1bbaa711…`).

`conformance/conformance.test.js` gains the check that would have caught it:
every figure the sample states must equal the sample's own `counts.*`, and a
key the sample does not count fails. It is self-contained (no
`test/detectors.js`), because a host pins `conformance/` without the template's
gate, so Databook runs it too. A self-test proves it sees a moved number and an
unknown key. It fails on v1.11.0's sample.

**Hosts that pin `conformance/` must re-pin** to keep their conformance test
green, because the expected digest moved. Databook:
`node scripts/template-pin.mjs update v1.12.0 --pin=compile.pin.json` from
`project-site/`. Instances (undatacommons-collab, comms-strat) need nothing
until they next take a version; their pinned fixtures pass as they are.

Tests: 448 → 450, in both the default and the band+rows variant.

## v1.11.0 — The Worker host reads `to=`: who a question waits on

**`worker/schema.sql` is unchanged, no setting changes, and the compiler's output
is unchanged** (`git diff v1.10.0 v1.11.0 -- packages/compile conformance` is empty).
A site with no `to=` behaves exactly as before; the rendered Questions page gains a
`data-waits-on` attribute on each card (its audience, for such a site), which the
page's filter reads. `build/` is byte-identical.

v1.10.0 let a question say who it waits on (`to=`), but only Databook read it. Now
this host does too, through one helper (`worker/src/waits.js`): a question waits on
its `to=` addressees when it has them, else on its audience.

- **Notifications and Home** ("waiting for you", "waiting on …"), the band layout's
  count, the Questions page's "waiting for me" filter, the About page's cards and the
  summary's per-group counts all follow it.
- **The People page** offers every audience and every addressee as a Group, so a
  person can be put in `platform-team` whether it is declared as one or the other.
- **The MCP** `list_questions` gains a `waiting_on` filter and returns `waiting_on`
  for each question; the chat's catalog says who each is for.
- **Why:** an instance can now move its addressing into `to=` and keep its audiences
  for visibility, which is what a move to Databook needs (Databook's audience is
  exactly `public` or `members`).

**Instances:** undatacommons-collab and comms-strat see no change on taking it
unless they write `to=`.

Tests: 441 → 448 (`worker/test/waits.test.js`; two notification tests in
`worker/test/api.test.js` that fail when the notification count goes back to the audience).

## v1.10.0 — Addressing: who a question is waiting on, apart from its audience

**The compiler's output changes, but only for a project that uses it.** No
setting is required and `worker/schema.sql` is unchanged. A project that writes
no `to=` and declares no `addressees` compiles byte-identical to v1.9.0
(measured on this repository's own site: `build/` and `_site/` identical), so
its digest does not move. `conformance/expected/` is regenerated in this
commit: the sample now addresses a public and a members question, so every
host's conformance test shows the new keys.

- **`to="name, name"`** on a `:::question{...}` names who it is waiting on: a
  role or a named person, each declared under a new optional `addressees:` map
  in `site.config.yml` (`{ name, describes }`, like `audiences`).
- **The manifest** gains `addressees` (only when declared) and `questions[].to`
  (only on a question that has `to=`), and the margin aside gains `data-to` and
  a "to …" label after the audience.
- **The build fails** on an undeclared addressee, an empty `to=`, a name given
  twice, or `to=` with no `addressees` declared: a typo never leaves a question
  waiting on nobody.
- **Why:** Databook reads `audience` as visibility (exactly `public` or
  `members`), so a collab site whose audiences are addressing
  (`platform-team`, `sarapis`) could not move there without hiding its public
  questions. `to=` carries the addressing; `audience` keeps meaning what each
  host says (HOST-CONTRACT.md, "Addressing").
- **The Worker host does not read `to` yet.** It still treats the audience as
  addressing; `to=` there only adds the label. Instances (undatacommons-collab,
  comms-strat) need nothing from this release unless they adopt `to=`.

Tests: 436 → 441 (`packages/compile/test/compile.test.js`: addressed, absent
when unused, undeclared, no addressees declared, empty and repeated). The
undeclared-name guard fails when its check is removed.

## v1.9.0 — Groups on the People page, and moving a document

**`worker/schema.sql` is unchanged.** No setting changes, and the compiler's
output is unchanged (`git diff v1.8.1 v1.9.0 -- packages/compile` is empty), so
a host that pins only the compiler needs nothing from this release.

**Groups.** `/admin/people/` called a person's audiences "Answers as" and took
them as free text. A typo (`owners`) was stored without complaint and matched no
question, so that person's Home read "0 waiting for you" and nothing said why.
The column and the form now say **Groups** and offer one checkbox per group
`site.config.yml` defines (its `audiences`, with each one's `describes` as the
hover text). The API refuses a name the site does not define and names the real
ones; a group the person already has still passes, so a renamed one can be
removed. If the manifest cannot be read the page falls back to the old text box
rather than locking the roster. Storage, the manifest and the MCP keep the word
`audiences`; new log entries read "groups changed".

**The deployed-with account can be edited.** It is listed without a row in the
table, so every change to it — its groups included — answered 404 "no such
person", and the owner could not be put in a group at all. Its first edit now
gives it a row (logged as "added"); it stays an admin whatever the row says.

**`POST /api/content/batch`** (rows sites). Several edits as one version, and
moves: `{ note, changes: [{path, base_revision, body?, status?}], moves: [{from,
to, base_revision, body?}] }`. A move could not be done before: the copy at the
new path and the original carry the same question slugs, so neither save
compiled. Every path is checked against the revision the editor opened and one
stale path refuses the batch; one compile, one D1 batch, all or nothing. A move
keeps the status and the question numbers (the lock keys them by slug, and
question ids are `project:slug`), re-points the document's comments, and removes
the old row with its revisions kept and a last revision noting where it went.
⚠️ It does not redirect the old URL, and the compiler does not check links.

Tests: 426 → 436 (`worker/test/admin.test.js`, `worker/test/rows.test.js`);
each new guard fails when its bug is put back. Checked under `wrangler dev
--local` on a band+rows copy: groups listed, a typo refused, the root put in a
group, a document moved (new page 200, old 404) and a stale batch writing nothing.

## v1.8.1 — A fix: a failed figures export no longer overwrites the last good one

**`worker/schema.sql` is unchanged.** No setting changes, and the compiler's
output is unchanged. Take this if your instance supplies `instance/figures.mjs`.

`npm run figures` wrote `content/figures.export.json` first and only then
noticed that the hook had exported nothing. The run failed, but the file was
already replaced by an empty export — so an instance whose measurements live in
another checkout (one reads its probe caches from a sibling repo) lost its good
export whenever that checkout was missing, and a commit of the result would make
every marked figure pass by matching nothing. The check now runs before the
write, and a failed run leaves the file untouched.

`test/export-figures.test.js` runs the script in a scratch project: a hook that
found nothing must exit 1 with the previous export byte-identical, and a hook
that found its figures must write them.

Tests: 424 → 426, in both the default and the band+rows variant.

## v1.8.0 — A private site's /llms.txt names the way in

**`worker/schema.sql` is unchanged.** No setting changes. Every private
instance's `/llms.txt` is rewritten by the next build; a public instance's is
untouched.

- The private notice said "the repository is the entry point and this URL is
  not". On a private instance the repository is usually private too, so an
  assistant was sent from a door it could not open to a door it was told not to
  try — while `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource` have been served anonymously since
  v1.2.0, which is exactly what claude.ai reads to offer the site as a custom
  connector. The notice now says this URL IS the way in and names `/connect`
  and `/mcp`.
- It also carries `project.tagline` and says what kind of thing the site is —
  documents with their open questions in the margin, numbers that never change,
  figures computed rather than typed — so an assistant with no access can still
  say what it is looking at instead of only "I need permission". And it says
  plainly that nothing in the file describes the project's state, so none is
  inferred from it.
- `agentIndexRot` gains the matching check: on a private instance the notice
  must name `/connect` and `/mcp`. Three self-tests, and the existing one that
  asserted a bare private notice was fine is now stricter, because it was not.

⚠️ The notice still must not name a document title or a question slug: on a
private instance it is the only thing a stranger is served, and the gate
asserts both. The project's name and tagline are named public fields.

Tests: 422 → 424, in both the default and the band+rows variant.

## v1.7.0 — The page keeps room for the floating Ask button

**`worker/schema.sql` is unchanged.** No setting changes. Every page that
carries the assistant gets about 4.8rem of room at its foot; a site with
`chat.enabled: false` is untouched.

- The Ask button is `position: fixed`, so the page could end underneath it. On
  a phone it did: at the foot of a document the pill sat on the last contents
  link and, because a fixed element takes the taps as well as the space, that
  link could not be followed at all — with nothing about the page looking
  wrong. `body:has(.chat-open)` now reserves the dock's height plus its gap,
  so the room is on the page and the button stays where a thumb expects it.
- The band layout had its own version of this fix — 5rem of bottom padding on
  `.version-foot` — which would have stacked with the new one on a phone. It is
  removed: one reservation, in the widget the dock belongs to, in both layouts
  and at every width.
- `chatDockRoom` (`test/detectors.js`) checks the arithmetic rather than the
  spelling: it reads `min-height` and `bottom` off `.chat-open` and
  `padding-bottom` off the reservation, and fails when the room no longer
  clears the button. The two halves live in different rules and neither reads
  the other, so restyling the pill taller or trimming the padding would
  otherwise put the overlap back with every test green. This is also why the
  button now states its own `min-height` instead of leaving its height to the
  padding and the font.

Tests: 417 → 422, in both the default and the band+rows variant.

## v1.6.0 — A passthrough page cannot claim an address the site serves

**`worker/schema.sql` is unchanged.** No setting changes; nothing an instance
does today behaves differently.

- The gate refuses a `site.passthrough` entry whose served address is already a
  document's or one of this template's own pages (`passthroughCollisions` in
  `test/detectors.js`). Such an entry was two pages at one URL with no error
  anywhere: in the classic layout the copied file lands on top of the compiled
  page, in the band layout the Worker renders the document and never reaches
  the file. The check reads `site.config.yml` against the manifest, not the
  built tree, because whichever page loses the collision is also the evidence
  that there was one. It catches a directory `to` (which keeps the source
  file's name) and two entries at one address as well.
- The list of pages this template builds is now one const in `test/gate.test.js`
  (`TEMPLATE_PAGES`), read by the orphan check and the new one.
- TEMPLATE.md gains "What no test catches": binding probes (`env.ASSETS?.x` is a
  truthy RPC stub in workerd and 1101 on every page), `project.*` settings being
  compiled into a version rather than read at render time, and this passthrough
  trap. All three have broken a live site while the Node suite stayed green.

Tests: 411 → 417, in both the default and the band+rows variant.

## v1.5.0 — The header lists the documents, in dropdown menus

**`worker/schema.sql` is unchanged.** Band layout only; off unless set.

- `project.header_menus: true`: the header is the one place documents are
  listed. Home, the `project.pills` documents as pills, then a dropdown per
  document group; any listed document in no group goes in "More", so none
  becomes unreachable. The rail drops its documents list and keeps "where things
  stand", contents and comments. The menu holding the page you are on is marked.
  Dropdowns are `<details>`: they work with no script; the widget only keeps one
  open and closes them on Escape or a click elsewhere. On a phone a menu opens in
  place, full width.
- `project.doc_groups` entries may now name their documents exactly,
  `{label, docs: [slug, ...]}`, in the order to show them, as well as by
  `{label, prefix}`.

The variant build turns header menus on, so the whole gate checks pages that
carry them. Tests: 406 → 411.

## v1.4.0 — Choose the header's pills; group the documents

**`worker/schema.sql` is unchanged.** Band layout only; both settings are
optional and default to what v1.3.1 did.

- `project.pills`: the documents the header shows as pills, a list of slugs in
  order. Unset, every listed document is a pill (as before), which stops
  working once a site has more than a handful. A slug the viewer may not see,
  or that is not a listed document, is skipped.
- `project.doc_groups`: a list of `{prefix, label}`, in order. The rail and
  Home group the documents under those labels by slug prefix (`runbooks/`,
  `briefs/`, ...); the rest come last, under "Other documents".

Also a gate fix: in the band layout the gate named a self-contained page served
as-is (`site.passthrough`, e.g. `design/x.html`) `design/x.htmlindex.html`, so the
gate's exemption for such pages never matched and their own classes failed "every
class used is styled". The variant build now carries one (red before the fix).

Tests: 402 → 406.

## v1.3.1 — Band layout fixes from the first real site

**`worker/schema.sql` is unchanged.** Band layout only; classic is untouched.

From a design review of ctfg-collab at desktop, tablet and phone widths:

- **Narrow screens:** the Tools box is one wrapped row above the content
  whatever `project.tools` says. Opened as a column it pushed every page's h1
  down by a screen. The "Hide contents" switch is gone below desktop width,
  where the rail is under the content and the switch covered the Tools row.
- **Admin pages have icons**, so a closed (icons-only) Tools box still reaches
  them; they used to vanish.
- **"Where things stand" counts the documents the site lists**, as Home's card
  does. It counted every compiled file (About, partials, posts, decisions), so
  one page said both "1 document" and "6 documents".
- **Activity** titles each post and decision once, as a linked h2; the item's
  own h1 was a second, giant h1 inside a card.
- **Home has no breadcrumb**: it was one crumb repeating the name beneath it.
- The account corner is one row; blockquotes are styled; "Why asked:" has its
  space.

Tests: 400 → 402 (the crumb rule, the Activity heading rule, the admin icons).

## v1.3.0 — The export can be pulled by its target

**`worker/schema.sql` is unchanged.**

`content.export.mode` (`push`, the default and v1.1.0's behaviour, or `pull`).
In pull mode the target repository runs the nightly export itself through the
template's reusable workflow (`.github/workflows/content-export-pull.yml`),
with its own `GITHUB_TOKEN`: no deploy key, and no credential in any other
repository that can write to the target. The instance's own export workflow
does nothing. The site refuses to be exported into any repository but the one
its settings name. TEMPLATE.md has the target's workflow file.

Use it when the target's base branch cannot be protected (a private repository
on GitHub's free plan) or when a push to it deploys something.

Also: an unreachable site is reported in a sentence, not a stack trace.

## v1.2.1 — A fix: signed-in band pages threw in the Workers runtime

**`worker/schema.sql` is unchanged. Take this if you run `site.layout: band`.**

In v1.1.0 to v1.2.0, every page a SIGNED-IN person opened on a band-layout site
threw (Cloudflare error 1101), and MCP and the assistant read the unfiltered
binding. The code marked its own wrapper of `env.ASSETS` with a property and
probed the binding for it (`env.ASSETS?.real`). In the Workers runtime a binding
is an RPC stub, so asking it for any property it does not have returns a truthy
stub that throws when used. The tests passed because their `ASSETS` was a plain
object; a stranger never reached the code because a private site redirects them
first.

Fixed: the wrapper is recorded in a `WeakMap` and the binding is asked for
nothing but `fetch`. The band and rows tests now use a runtime-shaped binding
(`worker/test/fixture.js` `rpcBinding`): with the old code 39 of them go red.
Checked under `wrangler dev` (workerd) on the path that failed in production.

## v1.2.0 — Sign in with the CMS

**⚠️ `worker/schema.sql` changed:** one table added, `auth_tickets_used`
(`CREATE TABLE IF NOT EXISTS`). Apply it before turning the provider on; until
then a CMS sign-in is refused, safely, because the ticket cannot be burned.

A new sign-in provider for a CMS on another domain that hands identity across as
a signed, two-minute ticket (`worker/src/cms.js`; the pattern of
Civic-Tech-Field-Guide/ctfg-website's tenant pass). Like every provider it
proves an email and nothing else; the roster in D1 decides. It is on only when
both are set:

- `CMS_PASS_SECRET` (secret, 32+ characters, the same value the CMS holds)
- `CMS_URL` (var, `https://` only), and optionally `CMS_LABEL` for the button

A ticket is refused if it is for another host, from another sign-in attempt
(state, so nobody can sign you in as them), expired, claiming more than five
minutes, of another kind, or already used. The CMS must offer
`GET /api/collab-pass/start?host=&state=` and only mint for hosts it lists.
`worker/test/cms.test.js` holds a test vector the CMS's own test asserts too.

Nothing changes for an instance that does not set the two values.

## v1.1.0 — Databook's host features, ported to the Worker host

**⚠️ `worker/schema.sql` changed.** Five tables were added: `content_items`,
`content_revisions`, `site_versions`, `site_live`, `site_live_log`. All are
`CREATE TABLE IF NOT EXISTS`, nothing existing was altered, and only an instance
that sets `content.source: rows` ever writes them. Apply the file to your D1
anyway (`npx wrangler d1 execute <db> --remote --file worker/schema.sql`), so a
later switch to rows needs no second migration.

**Nothing changes for an instance that sets nothing.** Every new behaviour is a
new key in `site.config.yml` whose default is v1.0.0's (`worker/src/settings.js`).
Measured on this release: the classic sample's `_site/` and `build/` are
byte-identical to v1.0.0's, and the compiler's conformance output is unchanged
(same `conformance/expected/`, same digest).

What `npm run build` regenerates: `worker/src/site.generated.js` gains `HOST` and
`CONFIG_TEXT` exports. Commit the regenerated file.

New, each behind a setting (TEMPLATE.md has the table):

- **`site.layout: band`**: the header band with breadcrumb and page pills; the
  Tools box (About, Activity, Questions, Get involved; `project.tools`); Home with
  counted cards; About replacing Start here and Summary (301s); Get involved;
  Activity filterable by type, absorbing Decisions (301) and site updates; the rail
  with documents and "where things stand"; the version footer. Rendered by the
  Worker per viewer from the live version, with `no-store`.
- **`project.groups`**: named question topics, in order, in both layouts.
- **`content.source: rows`**: content in D1 with per-item statuses (Published,
  Members only, Draft, Archived; questions Open, Resolved, Hidden, Draft),
  revisions and restore, preview, rebuild on save in the Worker (a save that does
  not compile writes nothing), versions with a live pointer and rollback, and the
  editor at `/admin/content/`.
- **`content.export`**: the nightly Action (`.github/workflows/content-export.yml`)
  that writes the rows to a repository and path of your choosing, after checking
  the round trip (one digest across the rows, the exported tree and the live
  site). The Worker holds no git credential; the Action needs `EXPORT_TOKEN`,
  `EXPORT_DEPLOY_KEY` and the variable `COLLAB_URL`.
- **The per-item read gate**: `canRead(env, me, item)`; members-only items are a
  404 to anyone off the roster on every door (pages, `/api/`, `/mcp`,
  `/connect`, the assistant), applied once in `forViewer()`.

Compiler: `compileFiles({ files })` is the compiler over an in-memory project
(`packages/compile/src/core.js`); `compile({ root })` reads a directory and calls
it. The output is unchanged. A consumer pinning `packages/compile/` (Databook)
gains one file.

Tests: `npm test` runs with `--experimental-sqlite` (Node 22): the rows code is
tested against real SQLite with `worker/schema.sql`. The template's CI also runs
the whole gate on a band + rows build of the sample (`npm run variant`).

⚠️ Who may change the content widens on a rows site: an editor is an admin OR a
contributor (HOST-CONTRACT.md: "editors are admins plus the project's
reviewers"), and an editor's save is live. In git mode the same people needed a
merged commit. Review your contributors before switching.

Not in this release: an instance's own figures on Home cards (Home counts only
what the manifest counts); questions edited as separate fields (their status is a
field; their text is edited in the document).

## v1.0.0

The compiler, the Worker host, the widget and the gate, extracted from the two
collab-site instances (Databook's decisions 41 to 44).
