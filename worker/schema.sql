-- Answers and comments are USER CONTENT and live here, never in git. The
-- documents and the question catalog live in git and never here. Collapsing
-- the two stores is the mistake this design exists to avoid.

CREATE TABLE IF NOT EXISTS answers (
  id             TEXT PRIMARY KEY,
  question_id    TEXT NOT NULL,
  author_sub     TEXT NOT NULL,
  author_name    TEXT NOT NULL,
  body           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS answers_by_question ON answers(question_id, created_at);

-- Append-only. An answer is evidence a document quotes, so a silent rewrite
-- could leave a passage resting on text that no longer justifies it.
CREATE TABLE IF NOT EXISTS answer_revisions (
  id          TEXT PRIMARY KEY,
  answer_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  replaced_at TEXT NOT NULL,
  FOREIGN KEY (answer_id) REFERENCES answers(id)
);
CREATE INDEX IF NOT EXISTS revisions_by_answer ON answer_revisions(answer_id, replaced_at);

-- Free-standing: a user telling the team something without being asked.
-- Deliberately NOT GitHub issues, and they do not sync into them.
-- `doc` scopes a comment to a document; `section` further scopes it to one
-- passage. Both may be null, which is a comment about the project as a whole.
-- ⚠️ A section id can stop resolving when somebody renames a heading. A comment
-- MUST NOT disappear when that happens -- it falls back to the document thread
-- and says so. A comment that silently vanishes is worse than a stale anchor.
CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  thread      TEXT NOT NULL DEFAULT 'general',
  doc         TEXT,
  section     TEXT,
  parent_id   TEXT,
  author_sub  TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_by_created ON comments(created_at);
CREATE INDEX IF NOT EXISTS comments_by_doc ON comments(doc, section, created_at);

-- Drives the header badge ONLY. The worksheet must stay deterministic: same
-- URL, same content, for everyone. The moment this filters the list, two people
-- comparing screens disagree about what is open and neither can tell why.
CREATE TABLE IF NOT EXISTS seen (
  sub          TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL
);

-- Whether a person has been shown the orientation page.
--
-- ⚠️ Separate from `seen` above, and deliberately so: `seen` moves every time
-- somebody opens Notifications, and this must not. It records one thing once --
-- that /start/ has been served to this person -- which is what lets `/` send a
-- returning reader to the summary instead of re-explaining the site to them.
--
-- In D1 rather than the browser because it is a fact about a PERSON, not about
-- a device. Somebody who read the orientation on a laptop has read it; opening
-- the site on a phone should not start them over.
CREATE TABLE IF NOT EXISTS start_seen (
  sub TEXT PRIMARY KEY,
  at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  author_sub  TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  user_message      TEXT NOT NULL,
  assistant_message TEXT,
  model       TEXT,
  cited       TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS chat_by_session ON chat_turns(session_id, created_at);

-- Rate-limit counters for the PUBLIC assistant.
--
-- ⚠️ A roster-only assistant never writes here: its abuse surface is a handful
-- of named people. With CHAT_PUBLIC the assistant answers anyone, which makes
-- it metered spend behind an open endpoint, and these counters are the limit.
--
-- Two different jobs, and conflating them is the mistake. A per-address bucket
-- limits ONE caller. A daily ceiling limits THE BILL. A bucket alone does not
-- bound the bill: a thousand addresses each politely under the limit still
-- spends a thousand times.
--
-- ⚠️ In D1 rather than KV. A rate limit read from an eventually-consistent
-- store is not a rate limit, and counting in the same place the turns are
-- stored means the count cannot disagree with the evidence.
--
-- ⚠️ The bucket key holds a SALTED HASH of the address, never the address. The
-- nightly retention job deletes expired rows.
CREATE TABLE IF NOT EXISTS chat_rate (
  bucket     TEXT PRIMARY KEY,
  n          INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_rate_expiry ON chat_rate(expires_at);

-- People, and what they may do.
--
-- ⚠️ Deliberately NOT in git. The roster used to live in site.config.yml, which
-- meant every address was in the repository and, once committed, in its history
-- permanently -- carried by any clone, fork, or extracted template even after
-- somebody was removed. This table is the roster; the repo holds none of it.
--
-- The cost is that access is no longer reviewable in a diff, which is what the
-- membership_log below exists to replace.
CREATE TABLE IF NOT EXISTS users (
  email       TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user',   -- admin | contributor | user
  audiences   TEXT NOT NULL DEFAULT '[]',     -- JSON array of audience keys
  created_at  TEXT NOT NULL,
  created_by  TEXT,
  disabled_at TEXT
);

-- Append-only. Nothing in the application updates or deletes a row here.
--
-- ⚠️ This is what the pull request used to give for free: a record that somebody
-- was granted or refused access, by whom, and when. Without it a roster in a
-- database drifts exactly the way ops.civictech.guide's login list did -- it
-- stopped mirroring the list it was justified by, and became a judgement call
-- with no source behind it.
CREATE TABLE IF NOT EXISTS membership_log (
  id        TEXT PRIMARY KEY,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,   -- added | role_changed | audiences_changed | disabled | enabled | removed
  subject   TEXT NOT NULL,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS membership_log_at ON membership_log(at);

-- Settings an admin sets from the site rather than from a terminal.
--
-- ⚠️ CIPHERTEXT, never the value. This table sits beside answers, comments and
-- the roster, and is read by wrangler, by the admin API and by any export
-- script somebody writes later. Encrypted, a database dump on its own yields
-- nothing; the key (SETTINGS_KEY) stays a deploy-time secret.
--
-- ⚠️ Only the names in worker/src/secrets.js MANAGEABLE may land here. Without
-- that allowlist an admin could set ROOT_ADMIN or PUBLIC_READ through a form
-- meant for an API key.
--
-- ⚠️ SESSION_SECRET and ROOT_ADMIN are deliberately NOT manageable. The first
-- verifies the session of the admin who would change it; the second must work
-- when this database is empty, which is exactly when it cannot be the place it
-- is kept.
CREATE TABLE IF NOT EXISTS app_secrets (
  name   TEXT PRIMARY KEY,
  iv     TEXT NOT NULL,
  value  TEXT NOT NULL,
  set_at TEXT NOT NULL,
  set_by TEXT NOT NULL
);

-- ─── Content as rows (content.source: rows; v1.1.0) ─────────────────────────
--
-- ⚠️ Only an instance that sets `content.source: rows` writes these. For every
-- other instance they stay empty, and the documents and the question catalog
-- live in git as before. On a rows instance this is the reverse: these rows are
-- the content, edited on the site, and git holds a nightly EXPORT of them
-- (.github/workflows/content-export.yml) that nothing reads back.
--
-- The compiler stays the one renderer: a save writes the rows back into the
-- file tree the compiler reads (README.md, content/**.md, the lock), compiles it
-- in the Worker, and stores the output as a version.

-- One row per file of that tree. `path` is the file's path under the project
-- root: README.md, content/<slug>.md, content/questions.lock.
-- status: published | members | draft | archived. A draft is never compiled.
CREATE TABLE IF NOT EXISTS content_items (
  path        TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'published',
  body        TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);

-- Append-only: every state a row has had, the current one included, so any of
-- them can be restored. ⚠️ The primary key is what refuses two saves of the
-- same row from the same starting revision: the second one's batch fails whole.
CREATE TABLE IF NOT EXISTS content_revisions (
  path      TEXT NOT NULL,
  revision  INTEGER NOT NULL,
  status    TEXT NOT NULL,
  body      TEXT NOT NULL,
  saved_at  TEXT NOT NULL,
  saved_by  TEXT NOT NULL,
  note      TEXT,
  PRIMARY KEY (path, revision)
);

-- Every compiled version. `payload` is JSON: { manifest, fragments, sections,
-- sources, statuses, lockText }. `digest` is HOST-CONTRACT.md's, over manifest,
-- fragments and sources, so the rows, the git export and the live site can be
-- shown to carry the same one.
-- ⚠️ `id` is chosen by the save as MAX(id)+1, so two saves racing for the same
-- id collide on the primary key and the later batch fails whole: a version
-- always contains every save before it.
CREATE TABLE IF NOT EXISTS site_versions (
  id               INTEGER PRIMARY KEY,
  digest           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  created_by_name  TEXT,
  reason           TEXT,
  payload          TEXT NOT NULL
);

-- The live pointer: one row. A save inserts a version and moves this in the
-- same batch; a rollback moves it back.
CREATE TABLE IF NOT EXISTS site_live (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  version_id  INTEGER NOT NULL,
  moved_at    TEXT NOT NULL,
  moved_by    TEXT NOT NULL
);

-- Append-only: every move of the pointer, by whom and why.
CREATE TABLE IF NOT EXISTS site_live_log (
  at          TEXT NOT NULL,
  version_id  INTEGER NOT NULL,
  moved_by    TEXT NOT NULL,
  reason      TEXT
);

-- ─── Sign in with the CMS (v1.2.0; worker/src/cms.js) ─────────────────────
-- Each CMS ticket is accepted once. A row lives until the ticket would have
-- expired anyway, and the next sign-in sweeps it.
CREATE TABLE IF NOT EXISTS auth_tickets_used (
  sig         TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);

-- ─── Tasks (tasks.enabled; v1.13.0; worker/src/tasks.js) ─────────────────────
--
-- The work a question, an answer, a decision, a comment or a request creates,
-- so the people who answered can see what is being done about it. In D1, never
-- in git, like answers and comments: a task names people and carries working
-- notes. Only a site that sets `tasks.enabled: true` writes these.
--
-- ⚠️ `number` is the T-number (T1, T2 ...). It is given out ONCE: a task is
-- never deleted (Dropped is a status), so MAX(number) never goes down, and the
-- INSERT computes MAX+1 in the same statement, with UNIQUE as the backstop.
-- ⚠️ `assignee` for a person and `created_by_sub` / `by_sub` are email
-- addresses. They are never sent to a reader; the name is.
-- `doc` is where the task's source lives. It decides who may read the task:
-- a task from a document a viewer cannot see is not theirs to see either.
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  number          INTEGER NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('idea','open','in_progress','review','done','dropped')),
  assignee_kind   TEXT CHECK (assignee_kind IN ('person','group')),
  assignee        TEXT,
  source_kind     TEXT NOT NULL CHECK (source_kind IN ('question','answer','decision','comment','request','external')),
  source_ref      TEXT,
  source_anchor   TEXT,
  question_id     TEXT,
  doc             TEXT,
  links           TEXT NOT NULL DEFAULT '[]',
  created_by_sub  TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS tasks_by_question ON tasks(question_id);
CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks(status, updated_at);

-- Every change to a task, and every comment on one, oldest first. Append-only.
-- kind: created | status | assignee | edit | link | comment.
CREATE TABLE IF NOT EXISTS task_events (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  at         TEXT NOT NULL,
  by_sub     TEXT NOT NULL,
  by_name    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  from_value TEXT,
  to_value   TEXT,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS task_events_by_task ON task_events(task_id, at);
