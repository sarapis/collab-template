// The host settings an instance chooses in site.config.yml, normalized.
//
// ⚠️ Every default here is what v1.0.0 did, so an instance that sets nothing
// renders and behaves exactly as before. A new behaviour is a new key with an
// old default (TEMPLATE.md, "Override points").
//
//   site.layout       classic (the v1.0.0 sidebar, built by Eleventy) | band
//                     (header band, Tools box, Home, About, Get involved,
//                     Activity by type, the documents rail and the version
//                     footer, rendered by the Worker per viewer)
//   content.source    git (content/ in the repository) | rows (D1, edited on the
//                     site; needs layout: band)
//   content.export    where the nightly export writes the rows: repo, path,
//                     branch (the target's base), push_branch, and mode:
//                     push (v1.1.0: this repository's Action pushes the target
//                     with a deploy key) | pull (v1.3.0: the TARGET runs the
//                     export with its own token, and no write key exists)
//
// Project-level settings the compiler passes through in `project` are read
// from the manifest, not here: `project.tools` (open | closed),
// `project.groups` ([{key, label}]), `project.site_decisions` ([slug]),
// `project.pills` ([slug]: the header's pills; default every listed document)
// and `project.doc_groups` ([{prefix, label}]: the documents list's groups).
export function settingsFrom(config = {}) {
  const layout = config.site?.layout === 'band' ? 'band' : 'classic';
  const source = config.content?.source === 'rows' ? 'rows' : 'git';
  const ex = config.content?.export || null;
  const id = config.project?.id || 'project';
  return {
    layout,
    content: {
      source,
      export: ex?.repo ? {
        repo: String(ex.repo),
        path: String(ex.path || `collab/${id}`).replace(/^\/+|\/+$/g, ''),
        branch: String(ex.branch || 'main'),
        push_branch: String(ex.push_branch || `collab-export/${id}`),
        mode: ex.mode === 'pull' ? 'pull' : 'push',
      } : null,
    },
  };
}

// What is wrong with a combination of settings, as sentences. The gate fails on
// any, and build-worker-data refuses to generate.
export function settingsProblems(config = {}) {
  const out = [];
  const s = settingsFrom(config);
  if (config.site?.layout && !['classic', 'band'].includes(config.site.layout)) out.push(`site.layout is "${config.site.layout}"; it is classic or band`);
  if (config.content?.source && !['git', 'rows'].includes(config.content.source)) out.push(`content.source is "${config.content.source}"; it is git or rows`);
  if (s.content.source === 'rows' && s.layout !== 'band') out.push('content.source: rows needs site.layout: band (the Worker renders the rows; Eleventy never sees them)');
  if (config.content?.export && !config.content.export.repo) out.push('content.export names no repo');
  if (config.content?.export?.mode && !['push', 'pull'].includes(config.content.export.mode)) out.push(`content.export.mode is "${config.content.export.mode}"; it is push or pull`);
  if (s.content.export && !/^[\w.-]+\/[\w.-]+$/.test(s.content.export.repo)) out.push(`content.export.repo "${s.content.export.repo}" is not owner/name`);
  if (s.content.export && s.content.source !== 'rows') out.push('content.export is set but content.source is not rows: there is nothing to export');
  const tools = config.project?.tools;
  if (tools != null && !['open', 'closed'].includes(tools)) out.push(`project.tools is "${tools}"; it is open or closed`);
  const pills = config.project?.pills;
  if (pills != null && (!Array.isArray(pills) || pills.some((x) => typeof x !== 'string'))) out.push('project.pills is a list of document slugs, in order');
  const dg = config.project?.doc_groups;
  if (dg != null && (!Array.isArray(dg) || dg.some((g) => !g?.prefix))) out.push('project.doc_groups is a list of {prefix, label}, in order');
  const groups = config.project?.groups;
  if (groups != null && (!Array.isArray(groups) || groups.some((g) => !g?.key))) out.push('project.groups is a list of {key, label}, in order (a map would lose its order)');
  return out;
}
