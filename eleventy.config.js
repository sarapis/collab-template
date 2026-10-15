import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// Eleventy is the reference HOST, not the product. It consumes what the
// compiler emitted and knows nothing about question syntax -- which is the
// property that lets GridMarket or Databook embed the loop without adopting
// any of this.
export default function (eleventyConfig) {
  const config = yaml.load(fs.readFileSync('site.config.yml', 'utf8')) || {};
  // ⚠️ `site.layout: band` (worker/src/settings.js): the Worker renders every
  // page made from the content (documents, Home, About, Questions, Activity,
  // Get involved) per viewer, from the live version, and wraps the pages built
  // here in the same layout. So this build makes none of the first, and copies
  // the version where the Worker reads it and never serves it.
  const band = config.site?.layout === 'band';
  eleventyConfig.addPassthroughCopy({ 'widget/collab.js': 'collab.js' });
  eleventyConfig.addPassthroughCopy({ 'widget/collab.css': 'collab.css' });
  eleventyConfig.addPassthroughCopy({ 'design/tokens.css': 'tokens.css' });
  // The content editor exists only where the content is rows.
  if (config.content?.source === 'rows') eleventyConfig.addPassthroughCopy({ 'widget/content-editor.js': 'content-editor.js' });
  else eleventyConfig.ignores.add('site/admin-content.njk');
  if (band) {
    eleventyConfig.addPassthroughCopy({ 'site/band.css': 'band.css' });
    eleventyConfig.addPassthroughCopy({ 'build/version.json': '_build/version.json' });
    for (const page of ['docs', 'summary', 'activity', 'decisions', 'questions']) eleventyConfig.ignores.add(`site/${page}.njk`);
  } else {
    // The manifest is served: the Worker reads it for the badge and the MCP
    // tools, and an agent can fetch it directly. The markdown sources are served
    // too, so read_document returns what a contributor would edit rather than
    // HTML somebody has to un-render.
    eleventyConfig.addPassthroughCopy({ 'build/manifest.json': 'manifest.json' });
    // Each section's own HTML, so a question can show the passage it cites without
    // sending the reader away from the answer box they were typing in.
    eleventyConfig.addPassthroughCopy({ 'build/sections.json': 'sections.json' });
    eleventyConfig.addPassthroughCopy({ 'content': 'source' });
  }
  eleventyConfig.addPassthroughCopy({ 'site/site.css': 'site.css' });
  // ⚠️ Self-contained pages an instance serves as-is (`site.passthrough` in
  // site.config.yml: a list of {from, to}). Each is an artifact rather than a
  // document: nothing compiles it, the sidebar is not on it, and the gate
  // excludes it by name from the checks that assume this site's layout.
  for (const { from, to } of config.site?.passthrough || []) {
    eleventyConfig.addPassthroughCopy({ [from]: to });
  }

  eleventyConfig.addWatchTarget('build/manifest.json');

  eleventyConfig.addFilter('fragment', (slug) =>
    fs.readFileSync(path.join('build/fragments', `${slug}.html`), 'utf8'));

  // A contents list built from the same headings the anchors come from, so the
  // two cannot disagree. A hand-maintained contents list is a second copy.
  // The contents list is built from the RENDERED page, not from a parallel
  // list. Every page gets one the same way -- compiler-built documents and
  // hand-written pages alike -- and it cannot disagree with the headings it
  // points at, because it is made from them.
  // ⚠️ A wide table cannot shrink past its content and pushes the whole page
  // sideways on a phone. Wrapping it lets it scroll inside its own box, and
  // doing it here means no document has to remember to.
  eleventyConfig.addTransform('scrollable-tables', function (content) {
    if (!this.page.outputPath?.endsWith('.html')) return content;
    return content.replace(/<table>([\s\S]*?)<\/table>/g, '<div class="table-scroll"><table>$1</table></div>');
  });

  eleventyConfig.addTransform('contents', function (content) {
    if (!this.page.outputPath?.endsWith('.html')) return content;
    // A band page is wrapped (and its contents list made) by the Worker.
    if (content.startsWith('<!--collab:band ')) return content;
    const main = (content.split('<main>')[1] || '').split('</main>')[0];
    const items = [...main.matchAll(/<h([23])\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h[23]>/g)]
      .map(([, level, id, text]) => `<li class="l${level}"><a href="#${id}">${text.replace(/<[^>]+>/g, '').trim()}</a></li>`);
    const list = items.length ? `<ol>${items.join('')}</ol>` : '<p class="muted">No sections on this page.</p>';
    return content.replace(/(<nav class="toc" id="rail-contents">)[\s\S]*?(<\/nav>)/, `$1${list}$2`);
  });

  eleventyConfig.addFilter('where_group', (questions, group) =>
    (questions || []).filter((q) => q.group === group));

  // An explicit filter rather than nunjucks' selectattr, which silently passed
  // every document through and put the briefing in the activity feed. A filter
  // that quietly matches everything is the same class of bug as a checker that
  // quietly matches nothing.
  eleventyConfig.addFilter('of_type', (docs, type) =>
    (docs || []).filter((d) => d.type === type).sort((a, b) => String(b.date).localeCompare(String(a.date))));

  // ⚠️ NO INLINE FILTERING IN NUNJUCKS. `selectattr` passed everything through
  // and `{% for x in y if cond %}` ignored its condition -- both silently, and
  // both shipped a wrong page that looked deliberate. Every filter this project
  // uses is registered here, in JavaScript, where it can be read and tested.
  eleventyConfig.addFilter('documents', (docs) =>
    (docs || []).filter((d) => d.type === 'doc' && !d.menu && !d.partial));

  // Open questions per audience, so the summary can say who is holding what
  // without anybody typing a number that will rot.
  eleventyConfig.addFilter('open_by_audience', (questions) => {
    const counts = new Map();
    for (const q of questions || []) {
      if (q.resolved || q.hidden) continue;
      counts.set(q.audience, (counts.get(q.audience) || 0) + 1);
    }
    return [...counts.entries()].map(([audience, count]) => ({ audience, count }))
      .sort((a, b) => b.count - a.count);
  });

  eleventyConfig.addFilter('for_doc', (questions, slug) =>
    (questions || []).filter((q) => q.doc === slug));

  eleventyConfig.addFilter('head', (list, n) => (list || []).slice(0, n));

  eleventyConfig.addFilter('sections', (headings) =>
    (headings || []).filter((h) => h.level === 2 && h.id));

  eleventyConfig.addFilter('groups', (questions) =>
    [...new Set((questions || []).map((q) => q.group))].sort());

  return {
    dir: { input: 'site', output: '_site', includes: '_includes', data: '_data' },
    markdownTemplateEngine: 'njk',
    htmlTemplateEngine: 'njk',
  };
}
