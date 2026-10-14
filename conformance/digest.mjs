// The identity of a compiled version (HOST-CONTRACT.md, "Digest").
//
// SHA-256 over the canonical JSON of { manifest, fragments, sources }: object
// keys sorted at every depth, no whitespace, non-ASCII written as itself (UTF-8),
// not escaped. It is byte-for-byte what Python's
//   json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
// produces, so a JavaScript host and Databook's api (modules/projectsites.digest)
// agree on the same version. The conformance fixture's digest is checked by both.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v);

export function canonical(manifest, fragments, sources) {
  return Buffer.from(JSON.stringify(sortKeys({ manifest, fragments, sources })), 'utf8');
}

export function digest(manifest, fragments, sources) {
  return crypto.createHash('sha256').update(canonical(manifest, fragments, sources)).digest('hex');
}

// The source text of every document, keyed by slug: README.md at the project
// root, everything else under content/. What a stored version carries beside
// the fragments, so a reader can be shown the markdown a contributor edits.
export function sourcesOf(root, manifest) {
  return Object.fromEntries(manifest.docs.map((d) => [d.slug,
    fs.readFileSync(d.source === 'README.md' ? path.join(root, 'README.md') : path.join(root, 'content', d.source), 'utf8')]));
}
