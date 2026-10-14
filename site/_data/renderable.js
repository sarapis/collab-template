import fs from 'node:fs';
// The documents that get a page of their own. Partials are compiled and served
// as fragments for a template to include, and must not also be published at a
// URL of their own — two pages with the same prose is the drift this project
// keeps refusing elsewhere.
export default function () {
  const manifest = JSON.parse(fs.readFileSync('build/manifest.json', 'utf8'));
  return manifest.docs.filter((d) => !d.partial);
}
