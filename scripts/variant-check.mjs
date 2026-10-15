#!/usr/bin/env node
// Build and test this repository as a DIFFERENT instance would set it: the
// band layout with content as rows (`npm run variant`).
//
// ⚠️ The sample instance runs the defaults, so its own `npm test` exercises the
// classic layout end to end and the band layout only through the Worker tests.
// A gate check that assumes classic pages would pass here forever and fail the
// first fork that turned band on. This runs the WHOLE gate against a band+rows
// build of the same content, in a temporary copy, so both layouts are gated in
// the template on every push.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter((f) => f && !f.startsWith('_site/') && !f.startsWith('build/') && fs.existsSync(f));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-variant-'));
try {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(f, path.join(dir, f));
  }
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'));
  const cfg = path.join(dir, 'site.config.yml');
  let text = fs.readFileSync(cfg, 'utf8');
  if (!/^site:\n/m.test(text)) throw new Error('site.config.yml has no `site:` block to set the layout in');
  text = text.replace(/^site:\n/m, 'site:\n  layout: band\n')
    + '\ncontent:\n  source: rows\n  export:\n    repo: example/target\n    path: docs/collab\n';
  // A self-contained page served as-is (site.passthrough), with classes this
  // site does not style: the gate must exempt it by name in the band layout
  // too, which it failed to do until v1.4.0 (served.js named it x.htmlindex.html).
  fs.mkdirSync(path.join(dir, 'instance'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'instance/artifact.html'), '<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><title>Artifact</title></head><body><p class="its-own-class">A page with its own styling.</p></body></html>\n');
  text = text.replace(/^  passthrough: \[\]$/m, '  passthrough:\n    - { from: instance/artifact.html, to: artifact.html }');
  if (!text.includes('instance/artifact.html')) throw new Error('site.config.yml has no `passthrough: []` line to replace');
  fs.writeFileSync(cfg, text);
  // The band layout's own Get involved page shows this partial: the variant
  // carries one, so the page and the partial are gated together.
  fs.writeFileSync(path.join(dir, 'content/get-involved.md'), '---\ntitle: Get involved\npartial: true\n---\n\nThe project\'s own words about taking part.\n');
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: 'inherit' });
  run('npm', ['run', 'build']);
  run('npm', ['test']);
  console.log('variant (band + rows): built and passed the whole gate');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
