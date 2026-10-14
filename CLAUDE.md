# Sample collaboration site — agent context

This file is the INSTANCE's (TEMPLATE.md). A fork replaces it with its own
project's rules; keep the sections an agent needs on its first read.

Read `TEMPLATE.md` before editing any file outside content/, site.config.yml,
wrangler.jsonc, design/tokens.css or instance/: the rest belongs to the template
and `test/template-pin.test.js` fails if a fork edits it. `HOST-CONTRACT.md` says
what the compiler emits and what a host may rely on.

## Adding an artifact

```bash
npm run new -- "The title of the artifact"
```

Writes `content/<slug>.md` with its front matter, positions it after the
existing documents, and leaves an example question in the right shape.
⚠️ Do not hand-write the file, and do not add it to any list: the sidebar is
built from the manifest.

## Commands

```bash
npm run build     # compile, then build the site
npm test          # the gate + compiler + API tests
npm run check     # what CI runs
npm run figures   # regenerate content/figures.export.json (instance/figures.mjs if present)
```

## Rules that are not negotiable

Never renumber a question · questions authored inline · never a bulleted "Open
questions" · a missing `asked` round or audience fails the build · resolve in
the same commit that folds the answer in · the widget is strictly additive ·
answers, comments and people in D1, never in git · no human address in the
repository · every detector carries a self-test · never type a count · never
retype a quoted answer · one write path · never paste a token.
