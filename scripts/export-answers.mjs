#!/usr/bin/env node
// Writes content/answers.export.json from the live store.
//
// This is a build artifact committed to the repo, and it is worth more than
// backup: the quote verifier cannot run in CI while the answers live only in a
// datastore, so the most valuable check in the system stays a manual script.
// With the answers exported, it becomes a gate.
//
// ⚠️ GENERATED. Never edit it. It is somebody else's words, and it is
// overwritten on every export.
// ⚠️ Transcripts are NOT exported. They are other people's unedited words about
// things not yet decided, and they have a retention period for a reason.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const manifest = JSON.parse(fs.readFileSync('build/manifest.json', 'utf8'));
const byId = new Map(manifest.questions.map((q) => [q.id, q]));
if (!byId.size) { console.error('no questions in the manifest; build first'); process.exit(2); }

// Two ways in, and the D1 one needs no credential beyond the wrangler login a
// contributor already has. The HTTP one exists for a machine that has a token
// but no Cloudflare access.
function fromD1() {
  const sql = 'SELECT question_id, author_name, body, created_at, revision_count FROM answers ORDER BY created_at';
  const raw = execFileSync('npx', ['wrangler', 'd1', 'execute', 'collab-site', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  // wrangler prints a banner before the JSON, and may print more than one
  // document; take every `results` array it emitted.
  const dec = new (class { })();
  void dec;
  const rows = [];
  let i = raw.indexOf('[');
  while (i !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(i));
      for (const part of [].concat(parsed)) if (part?.results) rows.push(...part.results);
      break;
    } catch { i = raw.indexOf('[', i + 1); }
  }
  return rows;
}

async function fromHttp(base, token) {
  const ids = [...byId.keys()];
  const r = await fetch(`${base.replace(/\/$/, '')}/api/answers?q=${encodeURIComponent(ids.join(','))}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!r.ok) { console.error(`the store answered ${r.status}`); process.exit(1); }
  const { answers } = await r.json();
  return Object.entries(answers).flatMap(([question_id, list]) =>
    list.map((a) => ({ question_id, author_name: a.author_name, body: a.body, created_at: a.created_at, revision_count: a.revision_count })));
}

const base = process.argv[2] || process.env.COLLAB_URL;
const rows = base ? await fromHttp(base, process.env.COLLAB_TOKEN) : fromD1();

const bySlug = {};
for (const row of rows) {
  const q = byId.get(row.question_id);
  // ⚠️ An answer to a question that no longer exists is kept out rather than
  // filed under a slug nothing declares. A retired question's answers stay in
  // the store; the export describes the catalog as it is now.
  if (!q) continue;
  (bySlug[q.slug] ||= []).push({
    by: row.author_name, at: row.created_at, edits: row.revision_count ?? 0, body: row.body,
  });
}

const out = { generated_from: base || 'd1:collab-site', questions: Object.keys(bySlug).length, answers: bySlug };
fs.writeFileSync('content/answers.export.json', JSON.stringify(out, null, 2) + '\n');
console.log(`exported answers for ${out.questions} of ${byId.size} question(s)`);
