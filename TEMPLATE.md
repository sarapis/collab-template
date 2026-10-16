# Making a collaboration site from this template

A collaboration site holds documents that are still being written, with their
open questions beside the passages that raised them. People on the project's
roster answer in the margin; a test fails when the documents and their questions
drift apart. This repository is the machinery: a compiler (`packages/compile/`),
an Eleventy site (`site/`), a Cloudflare Worker that serves it with an API, an
MCP server, sign-in and an assistant (`worker/`), a widget (`widget/`), and the
gate (`test/`). It ships with a small sample project so it builds and passes its
own tests before you change anything.

`HOST-CONTRACT.md` says what the compiler emits and what any host may rely on.
`README.md` and `CLAUDE.md` here are the SAMPLE project's; yours replace them.

## The boundary

Every file is either the template's or the instance's.

- **The instance's** are listed in `instance-files.txt`: `content/`,
  `site.config.yml`, `wrangler.jsonc`, `design/tokens.css`, `README.md`,
  `CLAUDE.md`, `.mcp.json`, `instance/`, `docs/`, `worker/migrations/`, and the
  generated `worker/src/site.generated.js`. You may also add files of your own
  anywhere outside the template's code directories (a deck, a demo page).
- **Everything else is the template's.** Your fork records the template version
  it is built from in `template.pin.json`, with the SHA-256 of every template
  file, and `test/template-pin.test.js` fails if one differs by a byte, goes
  missing, or if you add a file inside `worker/src`, `site/`, `scripts/` or
  another template directory. CI also checks the pin itself against this
  repository (`npm run template -- verify`).

So a change to the host is made HERE, in `sarapis/collab-template`, and every
instance takes it with a new version. A change only your project needs goes in
one of your files. That is what keeps two sites built from this from becoming
two codebases.

## Instance settings

`site.config.yml` holds the project and the host settings that differ:

| Key | What it does |
| --- | --- |
| `project` | `id`, `name`, `tagline`, and anything a host reads (see HOST-CONTRACT.md) |
| `auth.read` | `private` (the default) or `public`. Keep it in step with `PUBLIC_READ` in `wrangler.jsonc` |
| `audiences`, `asked_rounds`, `references` | What questions may be addressed to (shown on `/admin/people/` as **Groups**, one checkbox each), when each round opened, and named outside links |
| `public` | What `/llms.txt` says: `repo`, `contact` (a team, never a person's address), `llms_txt: false` to publish nothing |
| `chat` | `enabled`, `retention_days` |
| `site.passthrough` | Self-contained pages copied as-is, `{from, to}`; the gate exempts them from layout checks, and refuses a `to` whose address is already a document's or a page's |
| `site.nav.artifacts` | Extra sidebar links under Artifacts, `{href, label}` (in the band layout, extra page pills) |
| `site.layout` | `classic` (the default: the v1.0.0 sidebar, built by Eleventy) or `band` (see "The band layout") |
| `content.source` | `git` (the default: `content/` in this repository) or `rows` (D1, edited on the site; needs `site.layout: band`) |
| `content.export` | Rows only. `repo` (owner/name), `path`, `branch` (the target's base, default `main`), `push_branch` (default `collab-export/<project.id>`): where the nightly Action writes the content |
| `project.tools` | Band only. `open` or `closed` (the default): whether the Tools box starts with its names showing |
| `project.groups` | Question topics with names, in order: a list of `{key, label}`. Unset, the raw `group` keys show, as before |
| `project.site_decisions` | Band only. Slugs of decision documents about the website itself, tagged "About this site" in Activity |
| `project.pills` | Band only. The documents shown as header pills, a list of slugs in order. Unset, every listed document |
| `project.doc_groups` | Band only. Named groups for the documents list: a list of `{label, docs: [slugs]}` (exactly those, in that order) or `{label, prefix}` |
| `project.header_menus` | Band only. `true`: the header lists every document, as the `project.pills` plus one dropdown per group (and "More"); the rail stops listing them |
| `gate.foreign_resources` | Other instances' D1 and KV ids and hostnames, which yours must never point at |

`wrangler.jsonc` holds your Cloudflare account, Worker name, custom domain, D1
database, KV namespace, `PUBLIC_READ` and the assistant's limits. Every value in
the sample is a placeholder.

`design/tokens.css` is your theme: colours, type and radii as CSS custom
properties, for light and both dark selectors. Theming goes through tokens only.

Every new key has a default that leaves an instance exactly as v1.0.0 built it
(`worker/src/settings.js`). A combination that cannot work (rows without the
band layout, an export without rows) fails the build with a sentence.

## The band layout

`site.layout: band` is the layout Databook's project sites settled on
(HOST-CONTRACT.md Part 2): a header band with a breadcrumb and the pages as
pills; a Tools box (About, Activity, Questions, Get involved) that opens with no
script; Home with cards counted from the live version; About in place of
`/start/` and `/summary/` (both 301 there); Get involved (your partial
`content/get-involved.md` if you write one, then the ways in this Worker
offers); Activity filterable by `?type=` with Decisions, posts, question rounds,
answers and comments, and site updates (`/decisions/` 301s to
`?type=decisions`); a rail with the documents and "where things stand"; and a
footer naming the live version, its digest and when it was published.

The Worker renders these pages per viewer from the LIVE VERSION
(`worker/src/version.js`): in git mode the build (`/_build/version.json`, never
served), in rows mode a row in D1. Pages Eleventy builds (admin, design,
notifications) are wrapped in the same layout. The theme is `design/tokens.css`
as always; `site/band.css` uses only its tokens.

**Per-item statuses** (rows mode): a document is Published, Members only, Draft
or Archived. Members only is a 404 to anyone not on the roster, sent `no-store`,
and gone from every list, count, `/manifest.json`, `/source/`, MCP and the
assistant: the rule is `canRead(env, me, item)` and the one place it is applied
is `forViewer()`, which every door reads through (`band.js` `viewEnv`). Draft is
never compiled. Archived still opens, with a banner, and leaves the menus. A
question's status (open, resolved, hidden, draft) is its attributes;
`draft=true` keeps it off the site and in the export's `drafts.json`.

## Content as rows

`content.source: rows` moves the documents, About and the question lock into D1
(`content_items`, with every revision in `content_revisions`). Editors (admins and
contributors) edit at `/admin/content/`. A save writes the rows back into the file
tree the compiler reads, compiles it in the Worker with the same compiler, and,
only if it compiles, inserts a version and moves the live pointer in one batch.
A save that does not compile changes nothing and returns the compiler's errors.
Preview shows an unsaved edit under a Draft banner. Making an earlier version
live is a rollback; restoring a revision is a save.

`POST /api/content/batch` saves several items as one version, and is the only
way to move a document to a new path (`moves: [{from, to, base_revision}]`): the
copy and the original share question slugs, so a move as two saves never
compiles. Question numbers, answers and comments follow the document; the old
URL is not redirected, and the compiler does not check links, so edit the site's
own links to it in the same batch.

To switch an instance:

1. Apply `worker/schema.sql` (v1.1.0 adds five tables).
2. Set `site.layout: band` and `content.source: rows`, build and deploy.
3. As an admin, open `/admin/content/` and "Import from the deployed build".
   From then on `content/` in this repository is only that seed: `npm run new`
   refuses, and edits made there reach nothing.

**The nightly export** (`.github/workflows/content-export.yml`) writes the rows to
git, to the repository and path `content.export` names, which may be another
repository than this one. ⚠️ The Worker never holds a git credential: the Action
reads `/api/content/export` with the read-only `EXPORT_TOKEN` (32 characters or
more; a Worker secret and, with the same value, a repository secret), checks the
round trip (the exported tree compiles, with the CLI's compiler, to the digest the
live site serves), and pushes ONE branch of the target, `push_branch`, with a
deploy key that exists only on the target (`EXPORT_DEPLOY_KEY`). It never pushes
the target's base branch. A rollback shows as a failed round trip that says so.
Set the repository variable `COLLAB_URL`. ⚠️ Members-only text is in the export:
the target must be private.

**Pull mode** (`content.export.mode: pull`, v1.3.0) is the safer choice when the
target's base branch cannot be protected, or when a push to it deploys
something: no write key exists at all. This repository's export workflow stands
down, and the TARGET runs the export on its own schedule with its own
`GITHUB_TOKEN`, through the template's reusable workflow, which refuses unless
the site's settings name that repository:

```yaml
# .github/workflows/collab-export.yml in the TARGET repository
name: collab content export
on:
  schedule: [{ cron: '45 6 * * *' }]
  workflow_dispatch: {}
permissions:
  contents: write
  pull-requests: write
jobs:
  export:
    uses: sarapis/collab-template/.github/workflows/content-export-pull.yml@v1.3.0
    with:
      site_url: https://collab.example.org
      template_ref: v1.3.0
    secrets:
      EXPORT_TOKEN: ${{ secrets.COLLAB_EXPORT_TOKEN }}
```

The target needs the secret `COLLAB_EXPORT_TOKEN` (the Worker's `EXPORT_TOKEN`)
and the setting "Allow GitHub Actions to create and approve pull requests". A
pull request opened this way does not start the target's own pull_request
checks; they run when it is merged.

## Override points

- **`instance/figures.mjs`**: where `npm run figures` reads measured numbers
  from. Without it, the figures are the manifest's counts. With it, its default
  export returns `{ generated_from, figures, missing }`.
- **A new kind of setting**: if your project needs the host to behave
  differently and no setting above does it, add the setting to the template
  (a config key with a default that leaves every other instance unchanged), not
  a branch in your copy.

## What no test catches

Three things that have already broken a live site, each of which a green Node
test suite said nothing about.

**Never read a property off an env binding.** In workerd a binding is an RPC
stub, so a property it does not have is not `undefined` — it is another truthy
stub, which throws the moment anything uses it. `env.ASSETS?.real` shipped in
v1.2.0 as a harmless-looking probe and every signed-in page answered 1101,
while the Node tests passed, because a plain object in a test really does
return `undefined`. Pass the binding, never ask it what it is; where the Worker
has to remember something about one, it is kept beside it in a WeakMap
(`worker/src/version.js`), not on it.

**Project settings live inside each version.** `project.*` is compiled into a
version, not read at render time, so changing it and deploying changes nothing
anybody can see. Rows mode needs a save afterwards — any item, unchanged is
fine — to compile a new version that carries the new settings. In git mode the
build does it. This looks exactly like a setting that does not work.

**A passthrough page is served at an address nothing else owns.** `to` is a
path, and a path can be a document's: `artifact/index.html` beside a document
`artifact` is one URL with two pages behind it, and which one a reader gets
depends on the layout (classic copies the artifact over the compiled page; band
renders the document and never reaches the file). The gate refuses the
collision now — `passthroughCollisions` in `test/detectors.js`, against the
documents and this template's own pages — but it is worth knowing why, because
the exemption that makes passthrough useful is also what made this invisible:
`site.passthrough` is the list of addresses the layout checks are told to skip.

## Starting a new site

1. Create a repository from this one (GitHub "Use this template", or clone and
   push). Then pin it to the version you started from:

   ```bash
   npm ci
   npm run template -- update v1.0.0
   ```

   That writes `template.pin.json`. Commit it.
2. Replace the sample: `content/`, `README.md` (it is also the site's
   `/start/` page and must keep its "Collaboration site — orientation" brief
   and `npm run new`), `CLAUDE.md`, `site.config.yml`.
3. Create your own Cloudflare resources and put their ids in `wrangler.jsonc`.
   ⚠️ Never another instance's: a fork that inherits its parent's D1 id reads
   and writes the parent's live database. List the other instances' ids under
   `gate.foreign_resources`.
4. Set the secrets with `wrangler secret put`: `ROOT_ADMIN` (the bootstrap
   admin), `SESSION_SECRET`, `SETTINGS_KEY`, and the provider and mail keys you
   use. A CMS on another domain can be a provider too: `CMS_PASS_SECRET` and
   `CMS_URL` (RELEASES.md, v1.2.0). Apply `worker/schema.sql` to the D1 database.
5. `npm run build && npm test`, then deploy (`npx wrangler deploy`, or set the
   `CLOUDFLARE_API_TOKEN` repository secret and let CI deploy on merge).

The sample's content has to exercise the gate: at least one partial (the
summary), one question that cites a section with `see=`, and one listable
document. Your content will too.

## Taking a new version

```bash
npm run template -- update v1.1.0   # rewrites every template file and the pin
npm ci && npm run build && npm test
```

`RELEASES.md` says what each version changed and whether it changed
`worker/schema.sql`.

Read the template's release notes first: a version that changes
`worker/schema.sql` needs the new statements applied to your D1 database.

## Consuming only the compiler

A host that is not this Worker (Databook is one) can take just the compiler and
the conformance fixtures with a MAP:

```bash
node scripts/template-pin.mjs update v1.0.0 --pin=compile.pin.json \
  --map=packages/compile/:compile/,conformance/:conformance/,scripts/template-pin.mjs:scripts/template-pin.mjs
```

and check them in its own tests the way `test/template-pin.test.js` does.

## Versions

Tags are `vMAJOR.MINOR.PATCH`. A change to the compiler's output is at least a
minor version, regenerates `conformance/expected/` in the same commit, and says
so in the release notes; every host's conformance test then shows exactly what
changed.
