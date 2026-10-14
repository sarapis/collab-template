import fs from 'node:fs';
// Parsed from the stylesheet itself so the page cannot disagree with the
// system. The dark value is read from the [data-theme="dark"] block, which is
// also what the gate checks for completeness.
export default function () {
  const css = fs.readFileSync('design/tokens.css', 'utf8');
  const block = (sel) => (css.split(sel)[1] || '').split('}')[0];
  const read = (src) => Object.fromEntries([...src.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const light = read(block(':root {'));
  const dark = read(block(':root[data-theme="dark"]'));
  const isColour = (v) => /^#|^rgb|^hsl|^oklch/.test(v);
  const rows = Object.entries(light).map(([name, v]) => ({ name, light: v, dark: dark[name] || null }));
  return { colours: rows.filter((r) => isColour(r.light)), other: rows.filter((r) => !isColour(r.light)), light, dark };
}
