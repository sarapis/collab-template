// The compiler's output contract, checked against fixtures (HOST-CONTRACT.md).
//
// The same file runs in the template and in every consumer that pins
// conformance/ (Databook's project-site). It compiles conformance/sample with
// the compiler beside it and requires the output to be byte-identical to
// conformance/expected, so a compiler that drifted, or a host vendoring a
// different one, fails here with the file that changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compile, SAMPLE, EXPECTED } from './compiler.mjs';
import { canonical, digest, sourcesOf } from './digest.mjs';

const r = compile({ root: SAMPLE });
const read = (f) => fs.readFileSync(path.join(EXPECTED, f), 'utf8');

test('the sample compiles cleanly and mints no number', () => {
  assert.deepEqual(r.errors, []);
  assert.equal(r.lockText, fs.readFileSync(path.join(SAMPLE, 'content/questions.lock'), 'utf8'));
});

test('the manifest is the expected manifest', () => {
  assert.equal(JSON.stringify(r.manifest, null, 2) + '\n', read('manifest.json'));
});

test('every fragment is the expected fragment, and there are no others', () => {
  const want = fs.readdirSync(path.join(EXPECTED, 'fragments'), { recursive: true })
    .filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort();
  assert.deepEqual(Object.keys(r.fragments).sort(), want);
  for (const slug of want) assert.equal(r.fragments[slug], read(`fragments/${slug}.html`), `fragment ${slug}`);
});

test('the sections are the expected sections', () => {
  assert.equal(JSON.stringify(r.sections, null, 2) + '\n', read('sections.json'));
});

test('the digest is the expected digest', () => {
  const sources = sourcesOf(SAMPLE, r.manifest);
  assert.equal(digest(r.manifest, r.fragments, sources), JSON.parse(read('digest.json')).sha256);
});

test('the fixture exercises what the contract promises', () => {
  const m = r.manifest;
  const q = (slug) => m.questions.find((x) => x.slug === slug);
  assert.ok(m.docs.some((d) => d.slug === 'start' && d.source === 'README.md'), 'README.md compiles as start');
  assert.ok(m.docs.some((d) => d.partial), 'a partial');
  assert.equal(m.docs.find((d) => d.type === 'decision').date, '2026-09-17', 'a decision date is the calendar day, in UTC');
  assert.equal(q('members-only').audience, 'members');
  assert.equal(q('worksheet-only').margin, false);
  assert.ok(q('cadence').resolved && q('withdrawn').hidden);
  assert.deepEqual(m.questions.map((x) => x.number), [1, 3, 4, 5, 6], 'a retired number leaves its gap');
  assert.deepEqual(q('what-scope').see.map((s) => s.kind), ['section', 'external']);
  assert.equal(m.quotes.length, 1);
  assert.equal(m.figures.length, 2);
  assert.ok(r.fragments.guide.includes('MEMBERS-ONLY-SENTINEL'), 'the compiler writes members text; hosts must remove it');
  assert.ok(!r.fragments.guide.includes('worksheet-only'), 'a margin=false question is not in the fragment');
});

test('the digest can see one changed byte', () => {
  const sources = sourcesOf(SAMPLE, r.manifest);
  const a = digest(r.manifest, r.fragments, sources);
  const b = digest(r.manifest, { ...r.fragments, guide: r.fragments.guide + ' ' }, sources);
  assert.notEqual(a, b);
  // Key order cannot change it.
  const shuffled = Object.fromEntries(Object.entries(r.fragments).reverse());
  assert.equal(digest(r.manifest, shuffled, sources), a);
  assert.ok(canonical({ é: 1 }, {}, {}).includes(Buffer.from('é', 'utf8')), 'non-ASCII is written as UTF-8, not escaped');
});
