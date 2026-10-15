#!/usr/bin/env node
// Generates worker/src/site.generated.js from site.config.yml.
//
// What the Worker needs from site.config.yml that is not a secret: the project's
// name and tagline, and the notice served at /llms.txt.
//
// ⚠️ The roster used to be generated here too. It is in the database now, so
// that no address is in this repository or its history.
//
// ⚠️ THE NOTICE DEPENDS ON `auth.read`, and the two cases are opposites.
//
// On a PRIVATE instance the notice is the only thing published, so it is built
// from named config fields and NEVER from the manifest: a document title or a
// question must not become public because somebody added a document.
//
// On a PUBLIC instance that rule protects nothing — every document is already
// served to anyone — and following it anyway is how a public site came to tell
// its readers it was private and that they should go to a repository instead.
// So a public instance builds a real index FROM the manifest, which is also the
// only version that cannot rot: the hand-written one it replaced advertised a
// corpus a third the size of the real one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { settingsFrom, settingsProblems } from '../worker/src/settings.js';
import { digest, sourcesOf } from '../conformance/digest.mjs';

const configText = fs.readFileSync('site.config.yml', 'utf8');
const config = yaml.load(configText) || {};
const problems = settingsProblems(config);
if (problems.length) {
  for (const p of problems) console.error(`site.config.yml: ${p}`);
  process.exit(1);
}
const settings = settingsFrom(config);
const pub = config.public || {};
const isPublic = config.auth?.read === 'public';

// ⚠️ Read, not required. `npm run build` compiles before this runs so the
// manifest is there; a private instance never needs it and must not fail for
// want of it.
const MANIFEST = 'build/manifest.json';
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;

const privateNotice = () => [
  `# ${config.project?.name || 'A collaboration site'}`,
  '',
  'A private collaboration site: documents that are still being written, carrying',
  'their open questions in the margin, worked on by people and their AI agents',
  'together.',
  '',
  '**The content is not published.** Reading it requires a sign-in, and this file',
  'is the only page served without one.',
  '',
  'If you are an AI assistant asked to get up to speed on this project, the',
  'repository is the entry point and this URL is not — the repository carries the',
  'orientation, the rules and an MCP configuration.',
  '',
  pub.repo ? `Repository: ${pub.repo}` : null,
  pub.contact ? `Access: ask ${pub.contact}.` : null,
  '',
  'Sign in: /auth/login',
];

// One line per document, grouped by what the document IS. Titles and paths come
// from the manifest, so a document appears here by being written and a renamed
// one cannot leave a dead link behind.
const listing = (type, heading, note) => {
  const docs = (manifest?.docs || [])
    .filter((d) => d.type === type && !d.partial && !d.menu)
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || a.nav - b.nav);
  if (!docs.length) return [];
  return ['', `## ${heading}`, note || null, '', ...docs.map((d) => `- [${d.title}](/${d.slug}/)`)]
    .filter((l) => l !== null);
};

const publicNotice = () => [
  `# ${config.project?.name || 'A collaboration site'}`,
  '',
  config.project?.tagline ? `> ${config.project.tagline}` : null,
  '',
  'This site is public and complete: every document, every open question and every',
  'answer is readable here without signing in. If you are an AI assistant asked to',
  'get up to speed on this project, read the briefing and then the open questions —',
  'together they are the state of it.',
  '',
  '## Start here',
  '',
  '- [Briefing](/start/): what this project is, how the site works, and how to contribute.',
  '- [Summary](/summary/): where it stands, every figure computed from the build rather than typed.',
  // ⚠️ The count comes from the manifest or is omitted. Typing it here is the
  // thing that made the previous file wrong, and it is the one number on this
  // page a reader would act on.
  manifest?.counts?.open
    ? `- [Open questions](/questions/): ${manifest.counts.open} of them, each with a frozen number so it can be cited in an email.`
    : '- [Open questions](/questions/): each with a frozen number so it can be cited in an email.',
  ...listing('doc', 'Findings and specifications',
    'The durable documents. Each carries its open questions beside the passage that raised them.'),
  ...listing('data', 'Data reports', 'Generated from the probe runs. Every number is measured.'),
  '',
  '## Everything as it happened',
  // ⚠️ The feed and the log are LINKED, not enumerated. Listing every post
  // and every decision would be most of this file and would push the documents
  // that matter below where anybody reads. The two index pages are complete.
  '',
  '- [Activity](/activity/): what happened and when, newest first, including the corrections.',
  '- [Decisions](/decisions/): what was chosen and why, so that reversing one is deliberate.',
  '',
  '## Machine-readable',
  '',
  '- /manifest.json — every document, question and figure as structured data.',
  '- /source/ — the markdown a contributor edits, rather than rendered HTML.',
  '- /mcp — MCP over HTTP with a per-person bearer token, for Claude Code and Claude Desktop.',
  '- /connect — MCP over OAuth, for claude.ai and Claude mobile.',
  '',
  '## Contributing',
  '',
  'Answering a question or leaving a comment happens on this site and needs no git.',
  'Documents and questions live in the repository and arrive as commits. Reading is',
  'open to anyone; writing is roster-only, so every answer carries the name of the',
  'person who wrote it.',
  '',
  pub.repo ? `Repository: ${pub.repo}` : null,
  pub.probe_repo ? `Probe, data and the MCP benchmark server: ${pub.probe_repo}` : null,
  pub.contact ? `To be added as a contributor: ask ${pub.contact}.` : null,
];

const notice = pub.llms_txt === false
  ? null
  : (isPublic ? publicNotice() : privateNotice()).filter((l) => l !== null).join('\n') + '\n';

const project = {
  name: config.project?.name || 'this project',
  tagline: config.project?.tagline || null,
};

// ⚠️ Only what the Worker needs and nothing it must not publish: the host
// settings (worker/src/settings.js), the extra page links, the assistant's
// switch, and the named public fields. In rows mode, the config text too: the
// Worker compiles the rows itself, and the compiler reads site.config.yml.
const host = {
  settings,
  nav_artifacts: config.site?.nav?.artifacts || [],
  chat: { enabled: !!config.chat?.enabled, retention_days: config.chat?.retention_days ?? 90 },
  public: { repo: pub.repo || null, contact: pub.contact || null, llms_txt: pub.llms_txt !== false },
};

const out = `// GENERATED from site.config.yml by scripts/build-worker-data.mjs. Do not edit.
// Change site.config.yml and run \`npm run build\`. The gate compares the two.
export const PUBLIC_NOTICE = ${JSON.stringify(notice)};

export const PROJECT = ${JSON.stringify(project, null, 2)};

export const HOST = ${JSON.stringify(host, null, 2)};

export const CONFIG_TEXT = ${settings.content.source === 'rows' ? JSON.stringify(configText) : 'null'};
`;

fs.mkdirSync('worker/src', { recursive: true });
fs.writeFileSync('worker/src/site.generated.js', out);
console.log(`worker data: ${notice ? `${isPublic ? 'public index' : 'private notice'} on` : 'notice off'}`);

// The band layout renders from a VERSION (worker/src/version.js). In git mode the
// version is this build: the compiler's output, its sources and its digest
// (HOST-CONTRACT.md "Digest"), copied to /_build/version.json, which the Worker
// reads and never serves.
if (settings.layout === 'band') {
  if (!manifest) { console.error('band layout: build/manifest.json is missing; compile first'); process.exit(1); }
  const fragments = Object.fromEntries(manifest.docs.map((d) => [d.slug, fs.readFileSync(path.join('build/fragments', `${d.slug}.html`), 'utf8')]));
  const sources = sourcesOf('.', manifest);
  const sections = JSON.parse(fs.readFileSync('build/sections.json', 'utf8'));
  const git = (args) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
  const version = {
    id: null,
    digest: digest(manifest, fragments, sources),
    // The commit's own time, not the clock: the same commit builds the same version.
    published_at: git(['log', '-1', '--format=%cI']) ? new Date(git(['log', '-1', '--format=%cI'])).toISOString() : new Date().toISOString(),
    published_by: null,
    commit: process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']),
    manifest, fragments, sections, sources, statuses: {},
    // So rows mode can import this build exactly, numbers and retired ones included.
    lockText: fs.existsSync('content/questions.lock') ? fs.readFileSync('content/questions.lock', 'utf8') : null,
  };
  fs.writeFileSync('build/version.json', JSON.stringify(version));
  console.log(`band layout: version ${version.digest.slice(0, 12)} (${manifest.docs.length} documents)`);
}
