// The boundary between the template and an instance (TEMPLATE.md).
//
// In a FORK, template.pin.json records the sarapis/collab-template version the
// fork is built from and the SHA-256 of every template-owned file. This test
// fails if one of them differs by a byte or goes missing, or if a file is added
// inside the template's code directories: either is a fork of the host, and the
// next template version would silently undo it or fight it. An instance changes
// what it owns (instance-files.txt) and nothing else.
//
// In the TEMPLATE itself there is no pin; the checks on the check still run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPin, matchesAny, parsePatterns, TEMPLATE_DIRS } from '../scripts/template-pin.mjs';

const PIN = 'template.pin.json';
const INSTANCE = parsePatterns(fs.readFileSync('instance-files.txt', 'utf8'));
// Hashed here rather than through the script, so an edit to the script cannot
// quietly make this pass.
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function walk(dir = '.', out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '_site', 'build', '.wrangler'].includes(e.name)) continue;
    const p = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p.replace(/^\.\//, ''));
  }
  return out;
}

const pinned = fs.existsSync(PIN) ? JSON.parse(fs.readFileSync(PIN, 'utf8')) : null;

test('the instance files are declared', () => {
  for (const must of ['site.config.yml', 'wrangler.jsonc', 'content/**', 'design/tokens.css']) {
    assert.ok(INSTANCE.includes(must), `instance-files.txt no longer names ${must}`);
  }
  // ⚠️ No template code directory may be declared the instance's wholesale:
  // that would turn the pin off for the host.
  for (const p of INSTANCE) {
    assert.ok(!TEMPLATE_DIRS.some((d) => p === `${d}**` || d.startsWith(p.replace(/\*\*$/, ''))),
      `instance-files.txt hands the whole of a template directory to instances: ${p}`);
  }
});

if (pinned) {
  test('every template-owned file is byte-identical to the pinned template version', () => {
    assert.ok(Object.keys(pinned.files).length >= 50, 'the pin lists too few files: was it truncated?');
    assert.ok(!pinned.map, 'a fork pins the whole template; a map belongs to a partial consumer');
    const bad = [];
    for (const [f, want] of Object.entries(pinned.files)) {
      if (!fs.existsSync(f)) bad.push(`${f}: missing`);
      else if (hash(f) !== want) bad.push(`${f}: differs from ${pinned.source} ${pinned.tag}`);
    }
    assert.deepEqual(bad, [], 'change these in the template, or move the change to an instance file (TEMPLATE.md)');
  });

  test('no file is added inside the template\'s code', () => {
    const added = walk().filter((f) => TEMPLATE_DIRS.some((d) => f.startsWith(d))
      && !(f in pinned.files) && !matchesAny(f, INSTANCE));
    assert.deepEqual(added, [], 'a new file in the host is a fork of it: add it to the template instead');
  });
} else {
  test('the template itself carries no pin', () => {
    assert.equal(fs.existsSync(PIN), false);
  });
}

test('the pin check can see one changed byte, a missing file and a wrong hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
  try {
    fs.mkdirSync(path.join(dir, 'compile'));
    fs.writeFileSync(path.join(dir, 'compile/a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'compile/b.js'), 'export const b = 2;\n');
    const files = {
      'packages/compile/a.js': hash(path.join(dir, 'compile/a.js')),
      'packages/compile/b.js': hash(path.join(dir, 'compile/b.js')),
    };
    const pin = path.join(dir, 'pin.json');
    fs.writeFileSync(pin, JSON.stringify({ source: 's', tag: 't', commit: 'c', map: { 'packages/compile/': 'compile/' }, files }));
    assert.deepEqual(checkPin(pin), []);
    fs.writeFileSync(path.join(dir, 'compile/a.js'), 'export const a = 2;\n');
    fs.rmSync(path.join(dir, 'compile/b.js'));
    const found = checkPin(pin);
    assert.equal(found.length, 2);
    assert.ok(found.some((m) => /a\.js: differs/.test(m)) && found.some((m) => /b\.js: missing/.test(m)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the added-file check can see a file slipped into the host', () => {
  assert.ok(TEMPLATE_DIRS.some((d) => 'worker/src/mine.js'.startsWith(d)));
  assert.equal(matchesAny('worker/src/mine.js', INSTANCE), false);
  assert.equal(matchesAny('content/anything.md', INSTANCE), true);
});
