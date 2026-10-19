// scripts/new-artifact.mjs, run in a scratch project so the real content/ is
// never touched, and its output compiled by the real compiler.
//
// ⚠️ The case that matters: the title was written into the front matter
// unquoted, so `npm run new -- "The CRM and email: how it works"` produced a
// file the build could not parse (comms-strat, 2026-10-19). Titles that look
// like a date, a boolean or a number parsed as one, silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileFiles } from '../packages/compile/src/index.js';

const SCRIPT = path.resolve('scripts/new-artifact.mjs');
const CONFIG = `project: { id: scratch, name: Scratch }
audiences:
  someone: { name: Someone, describes: "who the example question is for" }
asked_rounds:
  r1: { label: "First", new: true, opened: 2026-01-01 }
`;

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-artifact-'));
  fs.mkdirSync(path.join(dir, 'content'));
  fs.writeFileSync(path.join(dir, 'site.config.yml'), CONFIG);
  return dir;
}
const run = (dir, title) => spawnSync(process.execPath, [SCRIPT, title], { cwd: dir, encoding: 'utf8' });

// Each title broke, or silently changed type, when written unquoted.
const AWKWARD = [
  'The CRM and email: how it works', // a colon: not valid YAML at all
  'Plan #2 — next steps', // '#' starts a YAML comment
  'She said "yes"', // double quotes inside
  "Devin's notes", // a single quote
  '- a leading dash', // a YAML list item
  'true', // a boolean
  '2026-10-19', // a date
  '1234', // a number
  '[draft] scope', // a flow sequence
];

for (const title of AWKWARD) {
  test(`a title survives the scaffold and the compiler: ${title}`, () => {
    const dir = scratch();
    const r = run(dir, title);
    assert.equal(r.status, 0, r.stderr);
    const [name] = fs.readdirSync(path.join(dir, 'content'));
    const files = {
      'site.config.yml': CONFIG,
      [`content/${name}`]: fs.readFileSync(path.join(dir, 'content', name), 'utf8'),
    };
    const out = compileFiles({ files });
    assert.ok(out.ok, `did not compile: ${out.errors.join('; ')}`);
    const doc = out.manifest.docs.find((d) => d.source === `content/${name}`) ?? out.manifest.docs[0];
    assert.equal(doc.title, title, 'the title came back changed');
    assert.equal(typeof doc.title, 'string');
  });
}

test('a title with nothing to make a file name from is refused, and writes nothing', () => {
  const dir = scratch();
  const r = run(dir, '!!!');
  assert.notEqual(r.status, 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'content')), []);
});
