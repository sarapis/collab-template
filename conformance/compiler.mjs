// Where the compiler is, in the template (packages/compile) and in a consumer
// that vendors it beside this directory (Databook: project-site/compile).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const found = [path.join(HERE, '../packages/compile/src/index.js'), path.join(HERE, '../compile/src/index.js')]
  .find((p) => fs.existsSync(p));
if (!found) throw new Error('conformance: no compiler at ../packages/compile or ../compile');
export const { compile } = await import(pathToFileURL(found).href);
export const SAMPLE = path.join(HERE, 'sample');
export const EXPECTED = path.join(HERE, 'expected');
