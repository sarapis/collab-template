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
