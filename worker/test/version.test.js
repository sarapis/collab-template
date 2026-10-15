// The Worker's digest is HOST-CONTRACT.md's digest, and the settings default to
// what v1.0.0 did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compile } from '../../packages/compile/src/index.js';
import { compileFiles, readProject } from '../../packages/compile/src/index.js';
import { sourcesOf } from '../../conformance/digest.mjs';
import { digestOf } from '../src/version.js';
import { settingsFrom, settingsProblems } from '../src/settings.js';
import { ROOT } from './fixture.js';

const SAMPLE = path.join(ROOT, 'conformance/sample');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(ROOT, 'conformance/expected/digest.json'), 'utf8')).sha256;

test('the Worker computes the conformance fixture’s digest (WebCrypto = node:crypto = Python)', async () => {
  const r = compile({ root: SAMPLE });
  assert.equal(await digestOf(r.manifest, r.fragments, sourcesOf(SAMPLE, r.manifest)), EXPECTED);
});

test('the in-memory compiler is the disk compiler, byte for byte', () => {
  const disk = compile({ root: SAMPLE });
  const mem = compileFiles({ files: readProject({ root: SAMPLE }) });
  assert.equal(JSON.stringify(mem.manifest), JSON.stringify(disk.manifest));
  assert.deepEqual(mem.fragments, disk.fragments);
  assert.equal(mem.lockText, disk.lockText);
});

test('the compiler core imports nothing a Worker cannot load', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/compile/src/core.js'), 'utf8');
  assert.deepEqual(src.match(/from 'node:[^']+'/g) || [], []);
});

test('an instance that sets nothing gets v1.0.0’s behaviour', () => {
  assert.deepEqual(settingsFrom({}), { layout: 'classic', content: { source: 'git', export: null } });
  assert.deepEqual(settingsProblems({}), []);
});

test('settings that cannot work together are refused', () => {
  assert.match(settingsProblems({ content: { source: 'rows' } }).join(), /needs site.layout: band/);
  assert.match(settingsProblems({ site: { layout: 'band' }, content: { source: 'git', export: { repo: 'o/r' } } }).join(), /nothing to export/);
  assert.match(settingsProblems({ project: { groups: { scope: 'Scope' } } }).join(), /list of \{key, label\}/);
  assert.match(settingsProblems({ project: { tools: 'wide' } }).join(), /open or closed/);
  assert.deepEqual(settingsProblems({ site: { layout: 'band' }, content: { source: 'rows', export: { repo: 'Civic-Tech-Field-Guide/ctfg-website', path: 'docs/collab' } } }), []);
});

test('the export target is a setting with defaults', () => {
  const s = settingsFrom({ project: { id: 'ctfg' }, site: { layout: 'band' }, content: { source: 'rows', export: { repo: 'o/r', path: '/docs/collab/' } } });
  assert.deepEqual(s.content.export, { repo: 'o/r', path: 'docs/collab', branch: 'main', push_branch: 'collab-export/ctfg', mode: 'push' },
    'push is the default: v1.1.0\u2019s behaviour');
  assert.equal(settingsFrom({ site: { layout: 'band' }, content: { source: 'rows', export: { repo: 'o/r', mode: 'pull' } } }).content.export.mode, 'pull');
  assert.match(settingsProblems({ site: { layout: 'band' }, content: { source: 'rows', export: { repo: 'o/r', mode: 'both' } } }).join(), /push or pull/);
});

test('pills and document groups are checked for shape', () => {
  assert.match(settingsProblems({ project: { pills: 'plan' } }).join(), /list of document slugs/);
  assert.match(settingsProblems({ project: { doc_groups: [{ label: 'x' }] } }).join(), /\{prefix, label\}/);
  assert.deepEqual(settingsProblems({ project: { pills: ['a'], doc_groups: [{ prefix: 'runbooks/', label: 'Runbooks' }] } }), []);
});
