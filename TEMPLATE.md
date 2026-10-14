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
| `audiences`, `asked_rounds`, `references` | What questions may be addressed to, when each round opened, and named outside links |
| `public` | What `/llms.txt` says: `repo`, `contact` (a team, never a person's address), `llms_txt: false` to publish nothing |
| `chat` | `enabled`, `retention_days` |
| `site.passthrough` | Self-contained pages copied as-is, `{from, to}`; the gate exempts them from layout checks |
| `site.nav.artifacts` | Extra sidebar links under Artifacts, `{href, label}` |
| `gate.foreign_resources` | Other instances' D1 and KV ids and hostnames, which yours must never point at |

`wrangler.jsonc` holds your Cloudflare account, Worker name, custom domain, D1
database, KV namespace, `PUBLIC_READ` and the assistant's limits. Every value in
the sample is a placeholder.

`design/tokens.css` is your theme: colours, type and radii as CSS custom
properties, for light and both dark selectors. Theming goes through tokens only.

## Override points

- **`instance/figures.mjs`**: where `npm run figures` reads measured numbers
  from. Without it, the figures are the manifest's counts. With it, its default
  export returns `{ generated_from, figures, missing }`.
- **A new kind of setting**: if your project needs the host to behave
  differently and no setting above does it, add the setting to the template
  (a config key with a default that leaves every other instance unchanged), not
  a branch in your copy.

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
   use. Apply `worker/schema.sql` to the D1 database.
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
