#!/usr/bin/env node
// Regenerate conformance/expected/ from conformance/sample/ with this compiler.
//
// ⚠️ Run this ONLY when the compiler's output changes on purpose, in the same
// commit as that change and a new template version. Every host's tests compare
// against these files, so regenerating them to make a red test green is the one
// thing that defeats them.
import fs from 'node:fs';
import path from 'node:path';
import { compile, SAMPLE, EXPECTED } from './compiler.mjs';
import { digest, sourcesOf } from './digest.mjs';

const r = compile({ root: SAMPLE });
if (!r.ok) { for (const e of r.errors) console.error(`error: ${e}`); process.exit(1); }
const lock = fs.readFileSync(path.join(SAMPLE, 'content/questions.lock'), 'utf8');
if (lock !== r.lockText) { console.error('error: sample/content/questions.lock would change; the fixture must not mint numbers'); process.exit(1); }

fs.rmSync(EXPECTED, { recursive: true, force: true });
fs.mkdirSync(path.join(EXPECTED, 'fragments'), { recursive: true });
for (const [slug, html] of Object.entries(r.fragments)) {
  const f = path.join(EXPECTED, 'fragments', `${slug}.html`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, html);
}
fs.writeFileSync(path.join(EXPECTED, 'manifest.json'), JSON.stringify(r.manifest, null, 2) + '\n');
fs.writeFileSync(path.join(EXPECTED, 'sections.json'), JSON.stringify(r.sections, null, 2) + '\n');
const sha256 = digest(r.manifest, r.fragments, sourcesOf(SAMPLE, r.manifest));
fs.writeFileSync(path.join(EXPECTED, 'digest.json'), JSON.stringify({
  sha256, of: 'canonical JSON of { manifest, fragments, sources } (conformance/digest.mjs)',
}, null, 2) + '\n');
console.log(`conformance: ${Object.keys(r.fragments).length} fragments, ${r.manifest.counts.questions} questions, digest ${sha256}`);
