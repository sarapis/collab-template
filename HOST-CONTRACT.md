# The host contract

Two kinds of host render sites from one compiler:

- **the Worker host**, this repository: Eleventy builds `site/` into `_site/`, a
  Cloudflare Worker serves it with the API, MCP, sign-in and the assistant;
- **Databook** (`databook.nyc/sites/<slug>`): the compiler runs in a
  `site-compiler` service, the output is stored as versioned rows in Postgres,
  and Laravel renders each page per viewer.

This file says what both may rely on. Part 1 is the compiler's OUTPUT contract.
Part 2 lists every feature Databook's host layer added (its decisions 20 to 40)
and says which ones a Worker host is meant to gain (PORTABLE) and which belong to
Databook alone (DATABOOK-ONLY). Part 3 is what a later instance needs that this
template must not block.

The compiler lives in `packages/compile/` and is versioned with this repository's
tags. A consumer takes it at an exact tag and proves it has not drifted
(`scripts/template-pin.mjs`, TEMPLATE.md).

## Part 1. The compiler's output contract

### Input

The compiler reads the project either from a directory (`compile({ root })`) or
from memory (`compileFiles({ files })`, `packages/compile/src/core.js`, which
imports nothing from Node so a Worker can run it). The output is identical;
`worker/test/version.test.js` holds the two equal on the conformance fixture.

| Path (under the project root) | Role |
| --- | --- |
| `site.config.yml` | `project` (passed through whole), `audiences`, `addressees` (optional), `asked_rounds`, `references`. Other keys are the host's |
| `README.md` | Optional. Compiled as the document with slug `start`, `menu: project`, `nav: 0`, titled `project.name` unless its front matter says otherwise |
| `content/**/*.md` | Documents. Slug = path without `.md` (and without a trailing `/index`) |
| `content/questions.lock` | The frozen question numbers |

Front matter a document may carry: `title`, `nav` (sort order), `nav_id`, `type`
(default `doc`; the hosts use `post`, `decision`, `data`), `menu`, `partial: true`,
`date`, `author`. Questions are `:::question{...}` blocks inside a section, with
`slug`, `audience`, `group`, `asked`, and optionally `to="name, name"`, `margin=false`,
`resolved=#anchor`, `hidden=true`, `see="#section, other-doc#section, reference-name"`.

### The call

`compile({ root })` (from `packages/compile/src/index.js`) returns
`{ ok, errors, warnings, manifest, fragments, sections, lock, lockText, assigned, retiredNow }`.
`ok` is false whenever `errors` is non-empty, and then nothing may be published.
The CLI (`src/cli.js <root> [--check] [--out=DIR]`) writes `fragments/<slug>.html`,
`manifest.json` and `sections.json` under `build/`, and rewrites
`content/questions.lock` only if it changed; `--check` fails instead of minting a
number.

### The manifest

| Key | Contract |
| --- | --- |
| `project` | `site.config.yml`'s `project`, unchanged. ⚠️ Hosts keep their own settings here (Databook: `artifacts`, `tools`, `groups`, `site_decisions`, `moved`, ...) and the compiler never reads or alters them |
| `audiences` | The declared audiences, unchanged |
| `addressees` | The declared addressees, unchanged. ABSENT when `site.config.yml` declares none |
| `asked_rounds` | Each round with `opened` normalized to an ISO-8601 UTC timestamp. A round with no valid `opened` is an error |
| `docs[]` | `{ slug, title, nav, nav_id, type, menu, partial, date, author, source, headings[] }`, sorted by `nav` then slug. `date` is a CALENDAR DAY, `YYYY-MM-DD`, formatted in UTC (an unquoted YAML date is a midnight-UTC Date), or `null`. `source` is `README.md` or the path under `content/`. `headings[]` is `{ level, id, text, explicit }` |
| `questions[]` | Sorted by number. `{ id, slug, number, audience, to?, group, asked, margin, resolved, hidden, doc, section, section_title, see[], body, why }`. `id` is `<project.id>:<slug>`. `to` is the list of addressee keys a question names, in its order, and is ABSENT (not empty) on a question with no `to=`. `body` and `why` are HTML. `see[]` holds `{kind:'section', doc, section, title}` or `{kind:'external', name, url, label}`, each checked at compile time |
| `quotes[]` | `{ doc, slug, excerpt, text }` for every `<i data-answer="slug">` in the prose |
| `figures[]` | `{ doc, key, text }` for every `<i data-figure="key">` in the prose |
| `counts` | `{ documents, questions, visible, resolved, open }`, computed. ⚠️ A host that filters questions for a viewer recomputes these from what it kept, never shows the unfiltered ones |

### Fragments

One HTML string per document slug (partials included). Each question with
`margin` true is replaced in place by an
`<aside class="q q-open|q-resolved" id="q<N>" data-question="<id>" data-number="<N>" data-audience="<audience>">`
(plus `data-to="<key> <key>"` and a `<span class="q-to">to <name>, <name></span>` after the audience when the question has `to=`)
that carries its number link, audience, body, "Why asked", context links, a
resolved note, and an empty `<div class="q-answers" data-answers-for="<id>">`
where a host puts the answers. A `margin=false` question leaves nothing in the
fragment; it appears only in `questions[]`. Links are SITE-ROOT links
(`/questions/#q3`, `/<doc>/#<section>`): a host serving the site under a prefix
rewrites them (Databook: `projectsites.rewrite_links`).

### Sections

`sections` maps `<doc>#<heading id>` to the HTML from that heading to the next
heading at the same or a higher level, cut from the same fragment, so a
question can show the passage it cites. ⚠️ A section CONTAINS any margin asides
inside it, so it carries question text exactly as the fragment does.

### `questions.lock`

```json
{ "version": 1, "numbers": { "<slug>": 1, ... }, "retired": { "<slug>": 2, ... } }
```

Numbers are frozen once assigned and never reused. A slug that disappears moves
to `retired` with its number (the gap is the signal); one that comes back gets
its old number. The file is serialized sorted by number. A build that would
change it is a content change and belongs in the commit that caused it
(`--check`; Databook's publish refuses a stale lock).

### Addressing

`to=` says who a question is WAITING ON, apart from who may read it. Each name
is a key under `addressees` in `site.config.yml` (`{ name, describes }`, like an
audience): a role (`reviewers`, `platform-team`) or a named person. The compiler
fails the build on an undeclared name, an empty `to=`, a name given twice, or a
`to=` in a project that declares no addressees, so a typo never leaves a
question silently waiting on nobody. What a name maps to (a roster group, a set
of email addresses, a grant) is the host's.

Addressing is OPTIONAL and additive: a project that never uses it compiles to
exactly the output of the version before it (no `addressees` key, no `to` key,
no `data-to`), so its digest does not move.

- **Databook** reads `to` as addressing and `audience` as visibility, so a
  public question can wait on a named group without hiding it.
- **The Worker host** (v1.11.0) reads `to` as addressing when a question has it,
  and its audience otherwise (`worker/src/waits.js`), so a site that never writes
  `to=` behaves as before. A person's Groups (People page) can be any audience or
  addressee.

### Audience semantics

The compiler only checks that an audience is DECLARED. It writes every question,
whatever its audience, into the fragments, the sections and `questions[]`.
What an audience MEANS is the host's:

- **The Worker host** reads an audience as ADDRESSING: who a question is waiting
  on (`/questions/?open=1`, notifications). Who may read anything at all is one
  rule, `canRead()` in `worker/src/identity.js`, applied to pages, `/api/` and
  `/mcp` alike.
- **Databook** reads it as VISIBILITY, with exactly two values: `public` and
  `members`. A host that does this MUST remove members questions for a
  non-member from the fragments (`strip_members_html`), the sections, the
  question list and the counts (`for_viewer`), and from markdown sources
  (`strip_members_markdown`). An audience it does not recognize is treated as
  `members`: the safe reading of a visibility you do not understand is "not you".

### Digest

A compiled version is identified by
`SHA-256( canonical({ manifest, fragments, sources }) )`, where `sources` maps each
document slug to its markdown text, and `canonical` is JSON with object keys
sorted at every depth, no whitespace, and non-ASCII written as UTF-8 rather than
escaped: byte-for-byte Python's
`json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
JavaScript: `conformance/digest.mjs`. Python: Databook's
`api/modules/projectsites.digest`. Two hosts that agree on the digest agree on
the version; Databook's round trip (rows, git and the live site carry one
digest) depends on it.

### Conformance fixtures

`conformance/sample/` is a small project chosen to exercise every clause above:
both visibility audiences (with a members-only sentinel), addressing on a
public and on a members question, a margin and a
worksheet-only question, a resolved and a hidden one, a retired number, section
and external references, a partial, a figure, a quote, a decision and a post.
`conformance/expected/` holds its manifest, fragments, sections and digest.
`conformance/conformance.test.js` compiles the sample with the compiler beside
it and requires the output byte for byte; it runs in this repository and in
every consumer that pins `conformance/` (Databook does, and its api tests check
the same digest in Python and that a non-member's view drops the sentinel).
`conformance/build.mjs` regenerates the expected files, ONLY in the commit that
changes the compiler on purpose, together with a new tag.

## Part 2. Host-layer features, decision by decision

Databook's decisions are in its `docs/PROJECT-SITES-PLAN.md`. PORTABLE means the
next step ports it to the Worker host; DATABOOK-ONLY means it depends on
something only Databook has. "Today" says what the Worker host already does.

| Feature | Decisions | Tag | Today in the Worker host | Notes for the port |
| --- | --- | --- | --- | --- |
| Header band: breadcrumb (Workspace / project / page) and the pages as pills | 28, 34 | PORTABLE | Built in v1.1.0: `site.layout: band` (`worker/src/render.js`) | The band's colours come from design tokens, never `.db-*` |
| Tools box: About, Activity, Questions, Get involved; open or icons-only per `project.tools` | 26, 28, 35 | PORTABLE | Built in v1.1.0: `project.tools` | `project.tools` in site.config.yml, passed through the manifest |
| Home cards with live counts (and an instance's own figures) | 25, 31 | PORTABLE | Built in v1.1.0: Home, counted from the viewer's version, with "waiting for you" from D1 | Counts from the manifest or a host query, never typed |
| About replaces Start here and Summary (`/start`, `/summary` redirect to it) | 29 | PORTABLE | Built in v1.1.0: `/about/`; `/start/` and `/summary/` 301 there | `#method` and `#limits` anchors; "Where things stand" counted beneath |
| Get involved: the project's own partial `get-involved`, then the shared ways in | 30 | PORTABLE | Built in v1.1.0: `/get-involved/` | The ways in are the Worker's: roster sign-in, MCP at `/mcp`, `/connect` |
| Activity filterable by type (`?type=`), absorbing Decisions and site updates | 35 | PORTABLE | Built in v1.1.0: `/activity/?type=`; `/decisions/` 301s | `/decisions/` redirects to `?type=decisions`; "About this site" tag via `project.site_decisions` |
| Question topics with names, in order | 32 | PORTABLE | Built in v1.1.0, both layouts: `project.groups` | `project.groups`: a list of `{key, label}` |
| Status banners: Draft, Members only, Archived | 38 | PORTABLE | Built in v1.1.0: from the item's status | Driven by per-item status once content is rows |
| Version footer: live version, its digest and when it was published | 37, 38 | PORTABLE | Built in v1.1.0 | The digest is Part 1's |
| Side panel: the documents list and "where things stand" counts | 34, 35 | PORTABLE | Built in v1.1.0: the rail | Counts from the viewer's filtered manifest |
| Content as rows: documents, questions, About, Get involved, pages | 37, 40 | PORTABLE | Built in v1.1.0: `content.source: rows` (`worker/src/content.js`) | D1 tables; the rows are written back to the same file tree and compiled, so the compiler stays the one renderer |
| Per-item statuses (documents: Published, Members only, Draft, Archived; questions: Draft, Open, Resolved, Hidden; pages: Public, Members only, Draft, Archived) | 38 | PORTABLE | Built in v1.1.0 (question statuses are attributes; `draft=true` is new) | A draft never reaches a compiled version; a retired number stays a row |
| Revisions with restore; preview of an unsaved edit | 37, 38 | PORTABLE | Built in v1.1.0 | |
| Rebuild on save, with rollback; versions with a live pointer | 37 | PORTABLE | Built in v1.1.0: the Worker compiles with `compileFiles` | Insert a version and move the pointer in one transaction; rollback moves it back |
| The round-trip test: rows, git and the live site carry one digest | 37 | PORTABLE | Built in v1.1.0: `worker/test/rows.test.js` and the export Action | Part 1's digest, so it is checkable across hosts |
| Nightly export to a git repo by a scheduled Action; the server never holds a git write credential | 37 | PORTABLE | Built in v1.1.0: `content.export` (repo, path, branch, push_branch) | ⚠️ The target repo is a SETTING (Part 3) |
| Members-only items 404 to everyone else, sent `no-store`, kept off caches, sitemaps and `llms.txt` | 39 | PORTABLE | Built in v1.1.0: `canRead(env, me, item)` applied in `forViewer()` | Per-item gate inside `canRead()`; one read rule for pages, `/api/`, `/mcp` |
| Editors are admins plus the project's reviewers; members are the roster | 39 | PORTABLE | Built in v1.1.0: roster roles admin and contributor | Map onto the roster, not onto Databook grants |
| Questions edited as fields and placed in a document section | 40 | PORTABLE | Partly, in v1.1.0: a question's status is set as a field (`PATCH /api/content/question`); its text is still edited in the document | Placement writes the `:::question` block back into the file tree |
| Live artifacts: Databook pages framed as a site's pages (`project.artifacts`) | 20, 21, 22 | DATABOOK-ONLY | `site.nav.artifacts` links | The frame wraps Laravel routes; a Worker instance links out instead |
| Comments on artifacts, beside the questions that cite them | 22 | DATABOOK-ONLY | Comments on documents and sections | Needs live artifacts |
| Open-source recommendations moved to a Workspace queue | 23 | DATABOOK-ONLY | n/a | Annotation queue |
| Indexing, the story artifact, Digital Services' Home figures | 24, 25, 31, 33 | DATABOOK-ONLY | n/a | Digital Services content and its pages |
| Sign-in through Authentik, grants scoped `project:<slug>`, trust tiers | 7, 10, 39 | DATABOOK-ONLY | Providers prove an email, the roster authorizes | |
| Answers and comments as annotations; moderation and review queues; spot checks; public credit | 2, 14, 16 | DATABOOK-ONLY | Answers, comments and revisions in D1, roster-only writes | |
| The Laravel site frame, `.db-*` styling, the orange Analysis identity | 13, 34 | DATABOOK-ONLY | Eleventy, `design/tokens.css` | The Worker host themes through tokens only |
| The Workspace (`/my/projects`, `/workspace`) and "← Workspace" | 27 | DATABOOK-ONLY | n/a | The Worker breadcrumb's first crumb is the project |
| Not built anywhere yet: request to join, questions as tasks in Do Next, suggestions to PRs, project chat | phases 2b to 7 | n/a | The Worker host already has an assistant (`/api/chat`) | Port only once Databook builds and measures them |

## Part 3. What a later instance needs that the template must not block

These are requirements on the template's SHAPE. The export target became a
setting in v1.1.0; the others stand as written.

- **Another sign-in provider** (for example a signed, short-lived ticket from a
  CMS on another domain). Each provider in `worker/src/auth.js` has one job: prove
  an email address. It is on when its credentials exist (`enabled()`); the
  roster in D1 authorizes, never the provider. A new provider is added to the
  template under the same rule, so every instance can turn it on with
  credentials and none has to fork `auth.js`. Built in v1.2.0 as `worker/src/cms.js`
  ("Sign in with the CMS").
- **Private mode** (`PUBLIC_READ=false`, `auth.read: private`): the default in
  the sample. Its invariants: one read rule, `canRead()`, used by pages, `/api/`
  and MCP; `PUBLIC_ASSETS` is exactly `/tokens.css`; `/llms.txt` is built only
  from named public fields, never the manifest; the gate refuses
  `PUBLIC_READ=false` without `assets.run_worker_first`; the assistant answers
  an anonymous caller with 401 on a private instance even if `CHAT_PUBLIC` is set.
- **The nightly content export to a DIFFERENT repository** than the instance's
  own: when content-as-rows is ported, the export's target repository and path
  are settings, and the Action holds the write credential, never the Worker.
- **Theming through design tokens only**: an instance changes
  `design/tokens.css` (an instance file); `test/gate.test.js` checks every token
  is defined for light and both dark selectors.
