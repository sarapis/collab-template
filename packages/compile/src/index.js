import fs from 'node:fs';
import path from 'node:path';
import { compileFiles } from './core.js';

export { compileFiles, makeMarkdown, isoDate } from './core.js';

// Every markdown file under `dir`, recursively, sorted at every level.
function findMarkdown(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findMarkdown(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out.sort();
}

// The project under `root`, read from disk into the in-memory shape the
// compiler takes (core.js `compileFiles`). The output is the compiler's; this
// only decides which files it sees.
export function readProject({ root, contentDir = 'content', configFile = 'site.config.yml', lockFile = 'content/questions.lock' } = {}) {
  const files = {};
  const take = (abs) => { files[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8'); };
  take(path.join(root, configFile));
  const lockPath = path.join(root, lockFile);
  if (fs.existsSync(lockPath)) take(lockPath);
  const readme = path.join(root, 'README.md');
  if (fs.existsSync(readme)) take(readme);
  for (const f of findMarkdown(path.join(root, contentDir))) take(f);
  return files;
}

export function compile({ root, contentDir = 'content', configFile = 'site.config.yml', lockFile = 'content/questions.lock' } = {}) {
  return compileFiles({
    files: readProject({ root, contentDir, configFile, lockFile }),
    contentDir, configFile, lockFile,
    display: (p) => path.join(root, p),
  });
}
