# Start here

**This is a collaboration website made for humans and their AI agents.** This
page explains how the site works and how to take part in it. To go straight to
the project, open the [Summary](/summary/).

**Reading and writing are for the people on this project's roster.** Every
document, question and answer here needs a sign-in. (An instance can open
reading to anyone with `auth.read: public` in `site.config.yml`; writing always
stays roster-only, so every answer carries the name of the person who wrote it
and a document can quote it as evidence.)

This page is also the repository's README — the same file rendered in both
places, so cloning the repo and opening the URL show one document rather than two
descriptions that drift apart.

## What the site is for

A document that is still being written has two kinds of content in it: what the
authors know, and what they are guessing at. Most tools hide the difference. This
one makes it a visible property of the page, and then makes drift between the two
fail a test.

So a document here carries its **open questions** in the margin, beside the
passage that raised them. Someone who knows the answer writes it there. The
author folds the answer into the prose and marks the question resolved in the
same commit — and the trail from question to paragraph survives, so months later
"why does it say this?" has an answer with a date and a name on it.

## Two kinds of collaborator

**People with the repository.** They write the documents, author the questions,
and fold answers into the prose. Their contributions are commits.

**People with the URL.** They answer questions and leave comments through the
site. They need no repository access, no git, and no account beyond an email
address on the project's list.

Both are equal in the part that matters: an answer is attributed to whoever wrote
it, and the document quotes it as evidence.

## How to take part

**Answering.** Open [what is waiting for you](/questions/?open=1). Some questions
sit in the margin of the passage they affect; the rest are on the worksheet.
Answer in either place — they are the same question. You can edit your answer
afterwards, and edits keep a visible history, because an answer is evidence a
document will quote.

**Commenting.** The right-hand rail switches between Contents and Comments. Use
it for anything nobody asked about. A comment can be about a whole document or
about one section.

**Asking.** The assistant sits in the bottom right of every page and answers from
what is published here. It cannot change anything. Every conversation is stored
and the team can read it — what people ask is the best evidence of what these
documents fail to say.

## Getting started, in the order it actually happens

**Start by being added to the roster.** Ask the project's admins; then sign in
at [/auth/login](/auth/login) with that address. `/llms.txt` says only what
this project is and how to ask for access: on a private instance it is the one
thing published.

**To give your Claude live access to the project:**

| where | what to add |
|---|---|
| claude.ai, Claude mobile | `https://collab.example.org/connect` as a custom connector |
| Claude Code, Claude Desktop | `https://collab.example.org/mcp` |

Both reach the same tools and resolve to the same person.

**To answer questions and leave comments,** sign in and type into the margin of
the document. There is no git in this path and there does not need to be —
answering is the contribution.

**To write documents and author questions,** clone the repository:

```bash
git clone https://github.com/your-org/your-collab-site
cd your-collab-site && npm install && npm run build
```

`.mcp.json` in the repository points your Claude Code at this site's MCP server,
so the assistant you write with can read the catalog you are writing into.

## What the words mean here

- **Question** — something a document is guessing at, written beside the passage
  it affects, with a permanent number. Q3 means Q3 forever; a retired question
  leaves a gap rather than renumbering the rest.
- **The margin** — a question rendered beside its own section. Only questions a
  reader *of that passage* is placed to answer are anchored there; the others
  would make the document unreadable.
- **The worksheet** — [every question as a card](/questions/). `?open=1` is the
  shareable "what is still waiting on you".
- **Resolved** — the answer has been folded into the prose. The note collapses to
  "resolved · see …" rather than vanishing, so the trail survives.
- **Artifact** — a document being worked on, as opposed to the pages that
  describe the project's state.

## Editing

**Adding an artifact.** An artifact is a document being worked on. To start one:

```bash
npm run new -- "The title of the artifact"
```

That writes `content/<slug>.md` with its front matter, puts it after the existing
documents in the sidebar, and leaves an example question in the right shape.
Write it, then:

```bash
npm run build     # assigns question numbers, writes content/questions.lock
npm test          # the gate
git add -A && git commit -m "Add <title>" && git push
```

It appears under **Artifacts** in the sidebar on its own — there is no list to
register it in. Pushing to `main` runs the gate and deploys if it passes; if the
gate fails, nothing is published and the failure names what to fix.

Two things worth knowing before you start one. **`nav:` decides the order** in
the sidebar, and the scaffold puts a new document last — change the number to
move it. And **a document whose prose needs live figures** (counts that would
otherwise rot) can be marked `partial: true` and included by a template instead
of getting its own page; `content/summary.md` is the example.

**Adding a question.** Questions are authored inline, in the section they are
about, so the anchor cannot name a section that does not exist:

```
:::question{slug=a-permanent-slug audience=team group=general asked=r1}
The question, in one or two sentences.

**Why asked:** what is blocked until this is settled.
```

Then `npm run build`. It assigns the next free number and writes
`content/questions.lock` — **commit that file**, because the number is frozen
from that moment and every reference anyone writes down depends on it.
`margin=false` keeps a question off the document and on the worksheet only.

⚠️ **Do not write open questions as a bulleted list.** It is the natural thing to
do in a markdown document and it is the one thing that does not work: a bullet
has no number, reaches nobody's notifications, and can never be answered on the
site or marked resolved. The build rejects a document whose "Open questions"
section has bullets and no `:::question`.

**Resolving one.** Fold the answer into the prose, then add
`resolved=#the-section-that-now-says-it` in the same commit. If you quote an
answer, mark it `<i data-answer="the-slug">` and generate the text with
`npm run export` — never retype a quote.

**What the build rejects.** An audience or `asked` round the config does not
declare; a duplicate slug; a margin question under no heading; a `resolved`
pointing at an anchor no document declares; a stale `questions.lock`; a count
typed into prose that the build could compute.

**Connecting claude.ai or the Claude mobile app.** Add
`https://collab.example.org/connect` as a custom connector. It registers
itself, sends you here to sign in if you are not already, and asks once whether
to connect — the screen says exactly what it will be able to do. Claude Code
needs none of this and keeps using `/mcp`.

**Who may write** is a table in the database, managed at
[/admin/people](/admin/people/), and every change lands in an append-only
membership log. ⚠️ It used to be a list in `site.config.yml`, and it moved
because an address committed once is in the history permanently — carried by
every clone and every fork, long after the person is gone. Removing somebody and
deploying revokes a connector they have already authorised, because the roster is
re-read on every call.

## Running it

```bash
npm run new -- "Title"   # scaffold a new artifact
npm run build            # compile, then build the site
npm test                 # the gate: compiler, API, auth, chat, structure
npm run check            # what CI runs
npx wrangler deploy      # normally CI does this; see .github/workflows/deploy.yml
```

This instance was made from
[sarapis/collab-template](https://github.com/sarapis/collab-template). How the
template and an instance divide the files, and how to take a newer template, is
in `TEMPLATE.md`; what the compiler emits and what every host relies on is in
`HOST-CONTRACT.md`.

## For an AI assistant

```markdown
# Collaboration site — orientation

This site holds documents that are still being written, together with the open
questions they are hedging on. Read /summary/ for what this particular project
is and where it stands.

Adding a document: run `npm run new -- "Title"`, write it, `npm run build`,
`npm test`, commit, push. CI runs the gate and deploys. Do not hand-write the
file and do not register it in a list — the sidebar is built from the manifest.

Read in this order:
1. /summary/    what the project is, its artifacts, and what is outstanding
2. the artifacts themselves, listed on /summary/
3. /activity/   what happened and when (history; never overwritten)
4. /decisions/  choices made and why

Reading and writing need a per-person token or a signed-in session: this site
is private. A token for somebody who is not on the roster is refused, which is
the expected answer, not a misconfiguration.

Two doors to the same MCP server, and they resolve to the same person:
  POST /mcp      Claude Code and Claude Desktop. Per-person bearer token;
                 .mcp.json in the repo configures it from $COLLAB_TOKEN.
  POST /connect  claude.ai and the mobile app. OAuth 2.1 + Dynamic Client
                 Registration; add the site's URL as a custom connector and it
                 discovers the rest. You approve the connection once, signed in.

  Tools (both doors):
                 list_documents, read_document, list_questions(open, audience),
                read_question, post_answer, list_comments, reply_to_comment,
                get_design_tokens, list_activity, list_chat_sessions,
                read_chat_session

Rules for anything you write here:
- Do NOT invent questions. They are authored in the repo beside the passage they
  are about and carry frozen numbers that people cite in conversation.
- Do NOT write open questions as a bulleted list. Use a :::question block, or the
  question reaches nobody and can never be answered or resolved. The build
  rejects a document that lists questions as prose.
- Do NOT renumber, reuse, or tidy a question number. A retired one leaves a gap,
  and the gap is the correct signal that something was removed.
- A question's `asked` round and `audience` must already exist in site.config.yml.
  A missing one fails the build rather than defaulting.
- Resolve a question only in the same commit that folds its answer into the prose.
- Never retype a quoted answer; generate it with `npm run export`.
- Answers, comments and chat transcripts live in the database. Documents and
  questions live in git. Do not move either across that line.
- State what you verified and what you assumed. This site's whole point is making
  that difference visible.
```
