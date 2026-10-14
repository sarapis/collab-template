#!/usr/bin/env node
// Take files from sarapis/collab-template at an exact version, and prove they
// have not drifted since (TEMPLATE.md, "Taking a new version").
//
//   node scripts/template-pin.mjs update <tag> [--pin=FILE] [--from=DIR|URL] [--map=FROM:TO,...]
//   node scripts/template-pin.mjs verify       [--pin=FILE] [--from=DIR|URL]
//   node scripts/template-pin.mjs check        [--pin=FILE]
//
// A PIN (template.pin.json in a fork; project-site/compile.pin.json in Databook)
// names the source repository, the tag, the commit the tag pointed at, an
// optional MAP from template paths to local ones, and the SHA-256 of every file
// taken:
//
//   { "source": "sarapis/collab-template", "tag": "v1.0.0", "commit": "<40 hex>",
//     "map": { "packages/compile/": "compile/" },          // optional; default: same paths
//     "files": { "packages/compile/src/index.js": "<64 hex>", ... } }
//
// Without a map the pin takes the WHOLE template except instance-files.txt (a
// fork). With one it takes only the template paths the map names (Databook, which
// consumes the compiler and the conformance fixtures, not the host).
//
//   update  writes every pinned file at <tag>, deletes files the previous pin took
//           that the new version no longer has, and rewrites the pin. The ONLY
//           way the pinned files should ever change.
//   verify  the pin against the source: the tag still names the commit, and every
//           hash is what the source holds at that commit. Needs the network (CI).
//   check   the files on disk against the pin, offline. The tests do the same
//           thing independently; this is the same check for a person.
//
// ⚠️ This file is itself template-owned, so a fork's pin covers it: an edit that
// made `check` always pass would fail the fork's own pin test.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SOURCE = 'sarapis/collab-template';

// The template's code. An instance may not ADD a file under these either: a new
// file there is a fork of the host, not an instance setting.
export const TEMPLATE_DIRS = ['.github/', 'conformance/', 'packages/', 'scripts/', 'site/', 'test/', 'widget/', 'worker/src/', 'worker/test/'];

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function parsePatterns(text) {
  return text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

export function matchesAny(file, patterns) {
  return patterns.some((p) => (p.endsWith('/**') ? file.startsWith(p.slice(0, -2)) : file === p));
}

// template path -> local path, or null when the map does not take it.
export function localPath(file, map) {
  if (!map) return file;
  for (const [from, to] of Object.entries(map)) {
    if (from.endsWith('/') ? file.startsWith(from) : file === from) return to + file.slice(from.length);
  }
  return null;
}

// A source is a local checkout (a directory) or a git URL; `owner/repo` means GitHub.
function openSource(from) {
  if (fs.existsSync(from) && fs.statSync(from).isDirectory()) return { dir: from, cleanup() {} };
  const url = /^[\w.-]+\/[\w.-]+$/.test(from) ? `https://github.com/${from}.git` : from;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-pin-'));
  execFileSync('git', ['init', '--quiet', '--bare', dir]);
  execFileSync('git', ['-C', dir, 'fetch', '--quiet', '--tags', url, '+refs/heads/*:refs/remotes/origin/*'], { stdio: 'inherit' });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const git = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, ...args], { maxBuffer: 1 << 28, ...opts });

export function resolveTag(dir, tag) {
  return git(dir, ['rev-parse', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' }).trim();
}

// Every template-owned file at a commit, as { templatePath: Buffer }.
export function templateFiles(dir, commit, map) {
  const list = git(dir, ['ls-tree', '-r', '-z', '--name-only', commit], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const instance = parsePatterns(git(dir, ['show', `${commit}:instance-files.txt`], { encoding: 'utf8' }));
  const out = {};
  for (const f of list) {
    if (map ? localPath(f, map) === null : matchesAny(f, instance)) continue;
    out[f] = git(dir, ['show', `${commit}:${f}`]);
  }
  return out;
}

export function readPin(pinFile) {
  return JSON.parse(fs.readFileSync(pinFile, 'utf8'));
}

// Offline: every pinned file is on disk with its pinned hash. Returns problems.
export function checkPin(pinFile) {
  const pin = readPin(pinFile);
  const base = path.dirname(path.resolve(pinFile));
  const problems = [];
  for (const [f, want] of Object.entries(pin.files)) {
    const local = localPath(f, pin.map);
    const p = path.join(base, local);
    if (!fs.existsSync(p)) problems.push(`${local}: missing (pinned from ${f} at ${pin.tag})`);
    else if (sha256(fs.readFileSync(p)) !== want) problems.push(`${local}: differs from ${pin.source} ${pin.tag}`);
  }
  return problems;
}

function update(pinFile, tag, from, mapArg) {
  const old = fs.existsSync(pinFile) ? readPin(pinFile) : null;
  // A first pin that takes only part of the template says which part:
  // --map=packages/compile/:compile/,conformance/:conformance/
  const map = old?.map || (mapArg ? Object.fromEntries(mapArg.split(',').map((m) => m.split(':'))) : undefined);
  const source = old?.source || DEFAULT_SOURCE;
  const base = path.dirname(path.resolve(pinFile));
  const src = openSource(from || source);
  try {
    const commit = resolveTag(src.dir, tag);
    const files = templateFiles(src.dir, commit, map);
    for (const f of Object.keys(old?.files || {})) {
      if (!(f in files)) fs.rmSync(path.join(base, localPath(f, map)), { force: true });
    }
    const hashes = {};
    for (const [f, buf] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      const p = path.join(base, localPath(f, map));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
      hashes[f] = sha256(buf);
    }
    const pin = { source, tag, commit, ...(map ? { map } : {}), files: hashes };
    fs.writeFileSync(pinFile, JSON.stringify(pin, null, 2) + '\n');
    console.log(`${pinFile}: ${Object.keys(hashes).length} files from ${source} ${tag} (${commit.slice(0, 12)})`);
  } finally { src.cleanup(); }
}

function verify(pinFile, from) {
  const pin = readPin(pinFile);
  const src = openSource(from || pin.source);
  const problems = [];
  try {
    const commit = resolveTag(src.dir, pin.tag);
    if (commit !== pin.commit) problems.push(`tag ${pin.tag} now names ${commit}, the pin says ${pin.commit}`);
    const files = templateFiles(src.dir, pin.commit, pin.map);
    const want = Object.fromEntries(Object.entries(files).map(([f, b]) => [f, sha256(b)]));
    for (const f of new Set([...Object.keys(want), ...Object.keys(pin.files)])) {
      if (!(f in pin.files)) problems.push(`${f}: in ${pin.tag} but not in the pin`);
      else if (!(f in want)) problems.push(`${f}: in the pin but not in ${pin.tag}`);
      else if (want[f] !== pin.files[f]) problems.push(`${f}: the pin's hash is not ${pin.tag}'s`);
    }
  } finally { src.cleanup(); }
  return problems.concat(checkPin(pinFile));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (k) => rest.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const pinFile = opt('pin') || 'template.pin.json';
  const report = (problems, ok) => {
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length) process.exit(1);
    console.log(ok);
  };
  if (cmd === 'update' && rest[0] && !rest[0].startsWith('--')) update(pinFile, rest[0], opt('from'), opt('map'));
  else if (cmd === 'verify') report(verify(pinFile, opt('from')), `${pinFile}: matches its source at ${readPin(pinFile).tag}`);
  else if (cmd === 'check') report(checkPin(pinFile), `${pinFile}: every pinned file matches`);
  else {
    console.error('usage: template-pin.mjs update <tag> | verify | check  [--pin=FILE] [--from=DIR|URL]');
    process.exit(2);
  }
}
