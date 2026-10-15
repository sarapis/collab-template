#!/usr/bin/env node
// Scaffolds a new artifact: `npm run new -- "Its Title"`.
//
// It writes the front matter and a first question so nothing has to be
// remembered — the two things most often got wrong by hand are the nav order
// and the shape of a :::question block.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const title = process.argv.slice(2).join(' ').trim();
if (!title) {
  console.error('usage: npm run new -- "The title of the artifact"');
  process.exit(2);
}

const slug = title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/^-|-$/g, '');
const file = path.join('content', `${slug}.md`);
if (fs.existsSync(file)) {
  console.error(`${file} already exists.`);
  process.exit(1);
}

// Sit after everything currently in the sidebar rather than in the middle of it.
const existing = fs.readdirSync('content').filter((f) => f.endsWith('.md'))
  .map((f) => (fs.readFileSync(path.join('content', f), 'utf8').match(/^nav:\s*(\d+)/m) || [])[1])
  .map(Number).filter(Number.isFinite);
const nav = (existing.length ? Math.max(...existing) : 0) + 10;

const config = yaml.load(fs.readFileSync('site.config.yml', 'utf8')) || {};
// ⚠️ On a rows site (content.source: rows) content/ is only the seed the site
// was first imported from; a file written here never reaches the site.
if (config.content?.source === 'rows') {
  console.error('This site\'s content is edited on the site (content.source: rows): use /admin/content/, "New document".');
  process.exit(1);
}
const audience = Object.keys(config.audiences || {})[0] || 'someone';
const round = Object.keys(config.asked_rounds || {}).find((r) => config.asked_rounds[r].new)
  || Object.keys(config.asked_rounds || {})[0] || 'r1';

fs.writeFileSync(file, `---
title: ${title}
nav: ${nav}
---

# ${title}

One or two sentences saying what this document is and who it is for.

## A first section

Write the prose. Where you are guessing at something, say so in a question
beside the passage rather than hedging in the sentence.

:::question{slug=${slug}-first-question audience=${audience} asked=${round}}
The thing you are guessing at, as a question.

**Why asked:** what is blocked until this is settled.
:::
`);

console.log(`Created ${file}

Next:
  1. Write it. Delete the example question or make it a real one.
  2. npm run build     assigns question numbers and writes content/questions.lock
  3. npm test          the gate: anchors, audiences, rounds, counts
  4. git add -A && git commit && git push

It appears under Artifacts in the sidebar on its own; nothing else to register.
Pushing to main runs the gate and deploys if it passes.`);
