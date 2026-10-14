import fs from 'node:fs';
// The build artifact is the single source for nav, TOC, questions and counts.
// ⚠️ Counts in prose rot. Nothing in this site types a number that the compiler
// can compute.
export default function () {
  return JSON.parse(fs.readFileSync('build/manifest.json', 'utf8'));
}
