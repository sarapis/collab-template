#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { compile } from './index.js';

const args = process.argv.slice(2);
const root = path.resolve(args.find((a) => !a.startsWith('-')) || '.');
const outDir = path.join(root, (args.find((a) => a.startsWith('--out='))?.slice(6)) || 'build');
const check = args.includes('--check');

const r = compile({ root });

for (const w of r.warnings) console.warn(`warn: ${w}`);
for (const e of r.errors) console.error(`error: ${e}`);
if (!r.ok) { console.error(`\n${r.errors.length} error(s). Nothing written.`); process.exit(1); }

const lockPath = path.join(root, 'content/questions.lock');
const existing = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;

// --check is what CI runs: a build that would MINT a number is a content change
// and belongs in the pull request that caused it, not in a deploy nobody read.
if (check && existing !== r.lockText) {
  console.error('error: content/questions.lock is out of date. Run the build and commit it.');
  for (const a of r.assigned) console.error(`  would assign Q${a.number} to "${a.slug}"`);
  for (const s of r.retiredNow) console.error(`  would retire "${s}" (its number is kept, leaving a gap)`);
  process.exit(1);
}

fs.mkdirSync(path.join(outDir, 'fragments'), { recursive: true });
for (const [slug, html] of Object.entries(r.fragments)) {
  const f = path.join(outDir, 'fragments', `${slug}.html`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, html);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(r.manifest, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'sections.json'), JSON.stringify(r.sections, null, 2) + '\n');
if (existing !== r.lockText) fs.writeFileSync(lockPath, r.lockText);

for (const a of r.assigned) console.log(`assigned Q${a.number} -> ${a.slug}`);
for (const s of r.retiredNow) console.log(`retired ${s} (number kept; the gap is the point)`);
const c = r.manifest.counts;
console.log(`${c.documents} documents · ${c.questions} questions · ${c.open} open · ${c.resolved} resolved`);
