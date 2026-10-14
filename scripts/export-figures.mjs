// Write content/figures.export.json, so a number stated in PROSE can be gated.
//
// ⚠️ Why this exists. "Never type a count" was enforced only for templates,
// which can compute. Markdown prose cannot, so the rule was in practice "do not
// state a count in prose at all" — and the real violations found were spelled
// in WORDS ("all eight", "Two open questions"), which the digits-only detector
// cannot see. This makes the honest option available: mark the number,
// generate it, and let the gate compare.
//
// ⚠️ WHERE THE MEASUREMENT COMES FROM IS THE INSTANCE'S CHOICE. By default it is
// this project's own manifest. An instance that measures something else (one
// reads its probe caches from a sibling repo) supplies `instance/figures.mjs`,
// whose default export returns `{ generated_from, figures, missing }`. The
// mechanism does not care where the measurement comes from; it cares that the
// prose cannot drift from it. See TEMPLATE.md, "Override points".
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOOK = path.resolve('instance/figures.mjs');

async function fromManifest() {
  const MANIFEST = 'build/manifest.json';
  if (!fs.existsSync(MANIFEST)) {
    console.error(`${MANIFEST} is missing: run \`npm run build\` first`);
    process.exit(1);
  }
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  // key -> value. Adding a figure is a line here.
  return {
    generated_from: MANIFEST,
    figures: {
      'counts.documents': m.counts.documents,
      'counts.questions': m.counts.questions,
      'counts.visible': m.counts.visible,
      'counts.open': m.counts.open,
      'counts.resolved': m.counts.resolved,
    },
    missing: [],
  };
}

const r = fs.existsSync(HOOK) ? await (await import(pathToFileURL(HOOK).href)).default() : await fromManifest();
const figures = r.figures || {};
const missing = r.missing || [];

const out = { generated_from: r.generated_from, generated_at: new Date().toISOString().slice(0, 10), figures };
fs.mkdirSync('content', { recursive: true });
fs.writeFileSync('content/figures.export.json', JSON.stringify(out, null, 2) + '\n');

console.log(`figures: ${Object.keys(figures).length} exported from ${r.generated_from}`);
for (const [k, v] of Object.entries(figures)) console.log(`  ${k} = ${v}`);
for (const m of missing) console.error(`  ⚠️ skipped ${m}`);
// ⚠️ An empty export would make every figure in every document pass by
// matching nothing, so a hook that found nothing it was asked for fails.
if (missing.length && !Object.keys(figures).length) {
  console.error('nothing was exported: check where the measurements are read from');
  process.exit(1);
}
