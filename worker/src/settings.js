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
// `project.doc_groups` ([{label, docs}|{label, prefix}]: the documents list's
// groups) and `project.header_menus` (true: the header lists the documents, as
// dropdowns per group, and the rail does not).
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
  if (dg != null && (!Array.isArray(dg) || dg.some((g) => !(g?.prefix || (Array.isArray(g?.docs) && g.docs.length))))) out.push('project.doc_groups is a list of {label, docs: [slugs]} or {label, prefix}, in order');
  const hm = config.project?.header_menus;
  if (hm != null && typeof hm !== 'boolean') out.push('project.header_menus is true or false');
  const groups = config.project?.groups;
  if (groups != null && (!Array.isArray(groups) || groups.some((g) => !g?.key))) out.push('project.groups is a list of {key, label}, in order (a map would lose its order)');
  out.push(...tasksProblems(config, s));
  return out;
}

// Tasks (v1.13.0; worker/src/tasks.js): the work a question, an answer, a
// decision or a request creates, kept on the site in D1.
//
//   tasks.enabled     false (default) | true. Off, nothing is served and nothing
//                     changes: no page, no route, no tool, no notification.
//   tasks.link_kinds  how a task's {kind, ref} link renders, as
//                     {kind: {label, url}}, where `url` carries `{ref}`, e.g.
//                     hub: {label: Hub, url: "https://dash.example.org/tasks/{ref}"}.
//                     The template knows no tracker; an instance names its own.
//
// ⚠️ Only the band layout serves the pages, so `enabled: true` needs
// `site.layout: band`.
export const LINK_KIND = /^[a-z][a-z0-9_-]{0,31}$/;

export function tasksFrom(config = {}) {
  const t = config.tasks || {};
  const kinds = {};
  for (const [k, v] of Object.entries(t.link_kinds || {})) {
    if (LINK_KIND.test(k) && typeof v?.url === 'string') kinds[k] = { label: String(v.label || k), url: v.url };
  }
  return { enabled: t.enabled === true, link_kinds: kinds };
}

function tasksProblems(config, s) {
  const t = config.tasks;
  if (t == null) return [];
  const out = [];
  if (typeof t !== 'object' || Array.isArray(t)) return ['tasks is a map: {enabled, link_kinds}'];
  if (t.enabled != null && typeof t.enabled !== 'boolean') out.push('tasks.enabled is true or false');
  if (t.enabled === true && s.layout !== 'band') out.push('tasks.enabled: true needs site.layout: band (the Worker renders the task pages)');
  const kinds = t.link_kinds;
  if (kinds != null && (typeof kinds !== 'object' || Array.isArray(kinds))) out.push('tasks.link_kinds is a map: {kind: {label, url}}');
  else for (const [k, v] of Object.entries(kinds || {})) {
    if (!LINK_KIND.test(k)) out.push(`tasks.link_kinds key "${k}" is lowercase letters, digits, - and _`);
    if (!/^https?:\/\/[^\s"'<>]+$/.test(String(v?.url || '')) || !String(v.url).includes('{ref}')) {
      out.push(`tasks.link_kinds.${k}.url is an http(s) URL containing {ref}`);
    }
  }
  return out;
}
