// The sidebar, in one list.
//
// Two groups and a foot. Overview is how the project works and where it stands;
// Artifacts are the things being worked on. Adding or renaming an item is one
// line here rather than an edit to a template that drifts from the routes it
// points at.
//
// ⚠️ Questions stays in Overview and is not folded into Summary. A summary OF
// the open questions is not a substitute for the place they are answered, and
// it is what the notification links to.
import site from './site.js';

export default function () {
  const config = site();
  return {
    groups: [
      {
        label: 'Overview',
        // ⚠️ Summary is first because it is where `/` sends everybody who has
        // already been oriented. Start here is LAST: it is the page you need
        // once and then need to be able to find again, which is a different
        // job from the pages you use every visit. The prominent card at the top
        // of Summary is the other half of that -- the menu stops advertising
        // it, so the summary has to.
        items: [
          { href: '/summary/', label: 'Summary' },
          { href: '/questions/', label: 'Questions' },
          { href: '/activity/', label: 'Activity' },
          { href: '/decisions/', label: 'Decisions' },
          { href: '/start/', label: 'Start here' },
        ],
      },
      {
        label: 'Admin',
        // ⚠️ Rendered for everybody and revealed by the widget only to admins.
        // The server refuses the API regardless -- hiding a link is presentation,
        // not access control, and treating it as access control is how a page
        // ends up protected by nothing but a CSS rule.
        adminOnly: true,
        items: [
          { href: '/admin/people/', label: 'People' },
          { href: '/admin/log/', label: 'Conversation log' },
          { href: '/admin/settings/', label: 'Settings' },
        ],
      },
      // ⚠️ Data is its own group, NOT more Artifacts. An artifact is something a
      // person wrote and reasons about; these are machine output, one of them
      // 891 lines long. Folding them into Artifacts would bury four documents
      // under ten data dumps and make the sidebar unreadable — and the
      // distinction is real, because nobody edits a generated table.
      //
      // ⚠️ Only the `-latest` tables came across. The source repo also keeps a
      // dated snapshot beside each one, and a `-DATE`/`-latest` pair is two
      // copies of the same bytes — exactly the duplication this project refuses
      // everywhere else. The snapshots stay in the source repo as history.
      {
        label: 'Artifacts',
        // Documents come from the manifest and are appended to this group at
        // render time, so adding a document to content/ is enough.
        // An instance adds its own links (`site.nav.artifacts` in site.config.yml,
        // a list of {href, label}) ahead of the design system, which stays last.
        items: [...(config.site?.nav?.artifacts || []), { href: '/design/', label: 'Design system', last: true }],
      },
      {
        label: 'Data',
        // Filled from the manifest at render time: a document with `type: data`
        // lands here and nowhere else.
        items: [],
      },
    ],
  };
}
