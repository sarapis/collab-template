// The host settings of a v1.0.0 site: classic layout, content in git.
//
// ⚠️ The tests that import this exercise the classic layout's own behaviour
// (the `/` router, the manifest served as a file). They pin it, so a fork that
// turns on `site.layout: band` still runs them as written, against the classic
// code path they describe, instead of failing for the fork's choice.
export const CLASSIC = {
  settings: { layout: 'classic', content: { source: 'git', export: null } },
  nav_artifacts: [], chat: { enabled: true, retention_days: 90 }, public: { repo: null, contact: null, llms_txt: true },
};
