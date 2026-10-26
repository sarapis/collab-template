// worker/schema.sql runs on EVERY deploy (.github/workflows/deploy.yml, v1.13.2),
// against a database that already holds the live site's answers, comments,
// people and content. So every statement must be safe to run again: it may only
// add what is missing. A change that needs more (a new column, a renamed table,
// a backfill) is a guarded migration of its own, never a statement in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8')
  .replace(/--[^\n]*/g, '');
const statements = sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

test('worker/schema.sql has statements to check', () => {
  // Present first: an empty or unreadable file would pass the rule below vacuously.
  assert.ok(statements.length >= 10, `only ${statements.length} statements found`);
});

test('every statement in worker/schema.sql can be run again safely', () => {
  const bad = statements.filter((s) => !/^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER|VIEW) IF NOT EXISTS /i.test(s));
  assert.deepEqual(bad.map((s) => s.slice(0, 80)), [],
    'worker/schema.sql runs on every deploy, so it may only CREATE ... IF NOT EXISTS');
});

test('the deploy applies the schema before it deploys the code', () => {
  const wf = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const apply = wf.indexOf('d1 execute DB --remote --file worker/schema.sql');
  const deploy = wf.indexOf('run: npx wrangler deploy');
  assert.ok(apply > 0, 'the deploy workflow no longer applies worker/schema.sql');
  assert.ok(deploy > apply, 'the schema must reach the database before the code that reads it');
});
