import fs from 'node:fs';
import yaml from 'js-yaml';
export default function () {
  return yaml.load(fs.readFileSync('site.config.yml', 'utf8'));
}
