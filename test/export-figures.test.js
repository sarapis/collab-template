// scripts/export-figures.mjs, run in a scratch project so the real export is
// never touched.
//
// ⚠️ The case that matters: a hook that found NOTHING it was asked for (an
// instance whose probe checkout is missing) must fail WITHOUT writing. It used
// to write first and notice afterwards, so the run failed but the good export
// was already replaced by an empty one, and every marked figure then passed by
// matching nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('scripts/export-figures.mjs');
const GOOD = JSON.stringify({ generated_from: 'earlier', generated_at: '2026-01-01', figures: { 'a.b': 7 } }, null, 2) + '\n';

function project(hookResult) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figures-'));
  fs.mkdirSync(path.join(dir, 'instance'));
  fs.mkdirSync(path.join(dir, 'content'));
  fs.writeFileSync(path.join(dir, 'instance/figures.mjs'), `export default async () => (${JSON.stringify(hookResult)});\n`);
  fs.writeFileSync(path.join(dir, 'content/figures.export.json'), GOOD);
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
const exported = (dir) => fs.readFileSync(path.join(dir, 'content/figures.export.json'), 'utf8');

test('a hook that found nothing fails and leaves the existing export alone', () => {
  const dir = project({ generated_from: 'probe/cache', figures: {}, missing: ['corpus.json'] });
  const r = run(dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /nothing was exported/);
  assert.equal(exported(dir), GOOD, 'the previous export was overwritten by an empty one');
});

test('a hook that found its figures writes them', () => {
  const dir = project({ generated_from: 'probe/cache', figures: { 'a.b': 9 }, missing: [] });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(exported(dir));
  assert.equal(out.generated_from, 'probe/cache');
  assert.deepEqual(out.figures, { 'a.b': 9 });
});
