# Releases

What each version changed, for an instance deciding whether and how to take it
(`npm run template -- update <tag>`, TEMPLATE.md).

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

Not in this release: an instance's own figures on Home cards (Home counts only
what the manifest counts); questions edited as separate fields (their status is a
field; their text is edited in the document).

## v1.0.0

The compiler, the Worker host, the widget and the gate, extracted from the two
collab-site instances (Databook's decisions 41 to 44).
