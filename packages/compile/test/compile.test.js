import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import { reconcileLock } from '../src/lock.js';

// Every detector below is asserted BOTH ways: that it sees a violation, and
// that it stays quiet on valid input. A structural checker that silently
// matches nothing passes forever and is worse than no checker.

const CONFIG = `
project: { id: t, name: T }
audiences:
  devin: { name: Devin }
asked_rounds:
  r1: { label: One, new: false, opened: 2026-01-01 }
`;

function project(docs, config = CONFIG) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-'));
  fs.mkdirSync(path.join(root, 'content'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site.config.yml'), config);
  for (const [name, body] of Object.entries(docs)) fs.writeFileSync(path.join(root, 'content', name), body);
  return root;
}

const ok = (body) => `# Doc\n\n## Section {#sec}\n\n${body}\n`;
const goodQ = ':::question{slug=a audience=devin asked=r1}\nWhy?\n:::';

test('a valid catalog compiles clean', () => {
  const r = compile({ root: project({ 'a.md': ok(goodQ) }) });
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  assert.equal(r.manifest.questions.length, 1);
});

test('an audience the config does not declare fails the build', () => {
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=nobody asked=r1}\nWhy?\n:::') }) });
  assert.match(r.errors.join('\n'), /audience "nobody"/);
});

test('an asked round the config does not declare fails, rather than defaulting', () => {
  // Defaulting would file a new round under "you have already seen these",
  // and nothing would look wrong.
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin asked=r9}\nWhy?\n:::') }) });
  assert.match(r.errors.join('\n'), /asked round "r9"/);
});

test('a duplicate slug fails', () => {
  const r = compile({ root: project({ 'a.md': ok(goodQ), 'b.md': ok(goodQ) }) });
  assert.match(r.errors.join('\n'), /duplicate question slug "a"/);
});

test('a question with no slug fails', () => {
  const r = compile({ root: project({ 'a.md': ok(':::question{audience=devin asked=r1}\nWhy?\n:::') }) });
  assert.match(r.errors.join('\n'), /no slug/);
});

test('a margin question under no heading fails, because it has nothing to sit beside', () => {
  const r = compile({ root: project({ 'a.md': `${goodQ}\n` }) });
  assert.match(r.errors.join('\n'), /sits under no heading/);
});

test('an unanchored question under no heading is allowed', () => {
  const r = compile({ root: project({ 'a.md': ':::question{slug=a audience=devin asked=r1 margin=false}\nWhy?\n:::\n' }) });
  assert.equal(r.errors.length, 0, r.errors.join('; '));
});

test('a resolved question pointing at no real anchor fails', () => {
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin asked=r1 resolved=#nope}\nWhy?\n:::') }) });
  assert.match(r.errors.join('\n'), /not an anchor any document declares/);
});

test('a resolved question pointing at a real anchor passes', () => {
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin asked=r1 resolved=#sec}\nWhy?\n:::') }) });
  assert.equal(r.errors.length, 0, r.errors.join('; '));
});

test('a broken catalog mints no numbers', () => {
  // A build that half-succeeds would burn a number on a question that never
  // existed, and the gap it left would be a lie.
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=nobody asked=r1}\nWhy?\n:::') }) });
  assert.equal(r.manifest, null);
  assert.equal(r.lock, null);
});

test('an unanchored question is absent from the document but present in the manifest', () => {
  const root = project({ 'a.md': ok(':::question{slug=a audience=devin asked=r1 margin=false}\nWhy?\n:::') });
  const r = compile({ root });
  assert.equal(r.manifest.questions.length, 1);
  assert.equal(r.fragments.a.includes('data-question'), false);
});

test('a margin question IS rendered into the document, with no JavaScript involved', () => {
  const r = compile({ root: project({ 'a.md': ok(goodQ) }) });
  assert.match(r.fragments.a, /<aside class="q q-open"[^>]*data-question="t:a"/);
  assert.match(r.fragments.a, /Why\?/);
});

test('"Why asked" is lifted out of the body into its own field', () => {
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin asked=r1}\nQ body.\n\n**Why asked:** the reason.\n:::') }) });
  const q = r.manifest.questions[0];
  assert.match(q.why, /the reason/);
  assert.equal(/Why asked/.test(q.body), false);
});

test('an explicit heading id is used and does not render as visible text', () => {
  const r = compile({ root: project({ 'a.md': ok(goodQ) }) });
  assert.match(r.fragments.a, /<h2 id="sec">Section<\/h2>/);
  assert.equal(r.fragments.a.includes('{#sec}'), false);
});

test('a question records the section it sits under', () => {
  const r = compile({ root: project({ 'a.md': ok(goodQ) }) });
  assert.equal(r.manifest.questions[0].section, 'sec');
});

// --- the number freeze ----------------------------------------------------

test('inserting a question earlier does not renumber the ones after it', () => {
  const first = reconcileLock(null, ['a', 'b']).lock;
  assert.deepEqual(first.numbers, { a: 1, b: 2 });
  const second = reconcileLock(first, ['new', 'a', 'b']).lock;
  assert.deepEqual(second.numbers, { a: 1, b: 2, new: 3 });
});

test('retiring a question keeps its number, and the gap is the point', () => {
  const first = reconcileLock(null, ['a', 'b', 'c']).lock;
  const second = reconcileLock(first, ['a', 'c']).lock;
  assert.deepEqual(second.numbers, { a: 1, c: 3 });
  assert.deepEqual(second.retired, { b: 2 });
  const third = reconcileLock(second, ['a', 'c', 'd']).lock;
  assert.equal(third.numbers.d, 4, 'a retired number is never reused');
});

test('a question that comes back gets its original number, not a new one', () => {
  // The references people wrote down were about this question, and still are.
  const first = reconcileLock(null, ['a', 'b']).lock;
  const gone = reconcileLock(first, ['a']).lock;
  const back = reconcileLock(gone, ['a', 'b']).lock;
  assert.equal(back.numbers.b, 2);
  assert.deepEqual(back.retired, {});
});

// --- references ------------------------------------------------------------

const CONFIG_WITH_REFS = `
project: { id: t, name: T }
audiences:
  devin: { name: Devin }
asked_rounds:
  r1: { label: One, new: false, opened: 2026-01-01 }
references:
  live-site: { url: https://example.org, label: the live site }
`;

test('a question can cite a section in its own document', () => {
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin asked=r1 see="#sec"}\nWhy?\n:::') }) });
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  assert.deepEqual(r.manifest.questions[0].see[0].kind, 'section');
  assert.equal(r.manifest.questions[0].see[0].title, 'Section');
});

test('a question can cite a section in another document', () => {
  const root = project({ 'a.md': ok(':::question{slug=a audience=devin asked=r1 see="b#sec"}\nWhy?\n:::'), 'b.md': ok('') });
  const r = compile({ root });
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  assert.equal(r.manifest.questions[0].see[0].doc, 'b');
});

test('a citation of a section no document declares fails the build', () => {
  // ⚠️ The same failure as an anchor naming nothing: the question still lists,
  // and only the context silently disappears.
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin asked=r1 see="#ghost"}\nWhy?\n:::') }) });
  assert.match(r.errors.join('\n'), /cites a#ghost, which no document declares/);
});

test('a question can cite a named external reference', () => {
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin asked=r1 see="live-site"}\nWhy?\n:::') }, CONFIG_WITH_REFS) });
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  assert.equal(r.manifest.questions[0].see[0].url, 'https://example.org');
  assert.equal(r.manifest.questions[0].see[0].label, 'the live site');
});

test('an external reference the config does not declare fails the build', () => {
  // Named rather than pasted inline, so a URL that moves is one edit — and a
  // name nobody declared is caught rather than rendered as a dead link.
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin asked=r1 see="nowhere"}\nWhy?\n:::') }, CONFIG_WITH_REFS) });
  assert.match(r.errors.join('\n'), /cites "nowhere", which is neither an anchor nor a reference/);
});

test('a question with references renders them, and one without renders none', () => {
  const withRefs = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin asked=r1 see="#sec"}\nWhy?\n:::') }) });
  assert.match(withRefs.fragments.a, /class="q-see"/);
  const without = compile({ root: project({ 'a.md': ok(goodQ) }) });
  assert.equal(/class="q-see"/.test(without.fragments.a), false);
});

test('each section is emitted on its own, ending where the next one begins', () => {
  const md = '# Doc\n\n## One {#one}\n\nFirst body.\n\n## Two {#two}\n\nSecond body.\n';
  const r = compile({ root: project({ 'a.md': md }) });
  assert.match(r.sections['a#one'], /First body/);
  assert.equal(/Second body/.test(r.sections['a#one']), false, 'a section swallowed the one after it');
  assert.match(r.sections['a#two'], /Second body/);
});

test('a subsection stays inside its parent section', () => {
  const md = '# Doc\n\n## One {#one}\n\nBody.\n\n### Inner {#inner}\n\nInner body.\n\n## Two {#two}\n\nLast.\n';
  const r = compile({ root: project({ 'a.md': md }) });
  assert.match(r.sections['a#one'], /Inner body/, 'the parent should carry its subsection');
  assert.equal(/Last/.test(r.sections['a#one']), false);
});

test('a round with no opened date fails the build', () => {
  // ⚠️ Defaulting to the epoch would make every prior answer count as current,
  // so rewording a question would silently leave it answered — the exact
  // failure the date exists to prevent, and invisible because the build would
  // look fine.
  const config = `
project: { id: t, name: T }
audiences: { devin: { name: Devin } }
asked_rounds:
  r1: { label: One, new: false }
`;
  const r = compile({ root: project({ 'a.md': ok(goodQ) }, config) });
  assert.match(r.errors.join('\n'), /declares no `opened` date/);
});

test('a round whose opened value is not a date fails the build', () => {
  const config = `
project: { id: t, name: T }
audiences: { devin: { name: Devin } }
asked_rounds:
  r1: { label: One, new: false, opened: "soon" }
`;
  const r = compile({ root: project({ 'a.md': ok(goodQ) }, config) });
  assert.match(r.errors.join('\n'), /not a date/);
});

test('a dated round is normalised to an ISO instant', () => {
  const r = compile({ root: project({ 'a.md': ok(goodQ) }) });
  assert.equal(r.manifest.asked_rounds.r1.opened, new Date('2026-01-01').toISOString());
});

test('an unquoted front-matter date stays its own calendar day, in any time zone', () => {
  // js-yaml makes `date: 2026-09-17` a Date at midnight UTC. Formatted in New
  // York's time zone that used to read "Wed Sep 16". Node re-reads TZ on change.
  const before = process.env.TZ;
  try {
    for (const tz of ['America/New_York', 'UTC', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      const r = compile({ root: project({ 'd.md': '---\ntitle: D\ndate: 2026-09-17\n---\n\n# D {#d}\n' }) });
      assert.equal(r.manifest.docs.find((d) => d.slug === 'd').date, '2026-09-17', `in ${tz}`);
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('a quoted date and a missing date pass through as they are', () => {
  const r = compile({ root: project({
    'q.md': '---\ntitle: Q\ndate: "2026-09-17"\n---\n\n# Q {#q}\n',
    'n.md': '---\ntitle: N\n---\n\n# N {#n}\n',
  }) });
  const by = Object.fromEntries(r.manifest.docs.map((d) => [d.slug, d.date]));
  assert.equal(by.q, '2026-09-17');
  assert.equal(by.n, null);
});

// --- addressing (`to=`), apart from the audience -------------------------------

const CONFIG_WITH_ADDRESSEES = `${CONFIG}addressees:
  platform-team: { name: Platform team, describes: "The UN platform team." }
  ana: { name: Ana }
`;

test('to= names who a question waits on, in the manifest and on its aside', () => {
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin to="platform-team, ana" asked=r1}\nWhy?\n:::') }, CONFIG_WITH_ADDRESSEES) });
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  const q = r.manifest.questions[0];
  assert.deepEqual(q.to, ['platform-team', 'ana']);
  assert.equal(q.audience, 'devin', 'the audience is untouched by addressing');
  assert.deepEqual(Object.keys(r.manifest.addressees), ['platform-team', 'ana']);
  assert.match(r.fragments.a, /data-to="platform-team ana"/);
  assert.match(r.fragments.a, /<span class="q-to">to Platform team, Ana<\/span>/);
});

test('a question with no to= carries no to key, and a project with no addressees no addressees key', () => {
  // Absent, not empty: a project that never addresses a question compiles
  // byte-identical to the version before addressing existed.
  const r = compile({ root: project({ 'a.md': ok(goodQ) }) });
  assert.equal('to' in r.manifest.questions[0], false);
  assert.equal('addressees' in r.manifest, false);
  assert.doesNotMatch(r.fragments.a, /data-to=|q-to/);
});

test('an addressee the config does not declare fails, rather than waiting on nobody', () => {
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin to=platfrom-team asked=r1}\nWhy?\n:::') }, CONFIG_WITH_ADDRESSEES) });
  assert.match(r.errors.join('\n'), /addressed to "platfrom-team", which site\.config\.yml does not declare/);
});

test('to= with no addressees declared at all fails', () => {
  const r = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin to=ana asked=r1}\nWhy?\n:::') }) });
  assert.match(r.errors.join('\n'), /declares no addressees/);
});

test('an empty to= and a repeated addressee fail', () => {
  const empty = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin to="" asked=r1}\nWhy?\n:::') }, CONFIG_WITH_ADDRESSEES) });
  assert.match(empty.errors.join('\n'), /empty to=/);
  const twice = compile({ root: project({ 'a.md': ok(':::question{slug=a audience=devin to="ana ana" asked=r1}\nWhy?\n:::') }, CONFIG_WITH_ADDRESSEES) });
  assert.match(twice.errors.join('\n'), /names an addressee twice/);
});
