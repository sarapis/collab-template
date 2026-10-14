// Explicit heading ids: `## Notification policy {#notify}`.
//
// Explicit rather than slugified-from-text ON PURPOSE. A generated id changes
// when somebody rewords a heading, which silently moves every anchor pointing
// at it -- and a question's anchor is the one thing in this system that must
// not move. A slugified fallback exists so short documents need no ceremony,
// but anything a question or a cross-link points at should declare its id.
const EXPLICIT = /\s*\{#([A-Za-z][\w-]*)\}\s*$/;

export function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
}

export function headingIds(md) {
  md.core.ruler.push('collab_heading_ids', (state) => {
    const seen = new Set();
    for (let i = 0; i < state.tokens.length; i++) {
      const tok = state.tokens[i];
      if (tok.type !== 'heading_open') continue;
      const inline = state.tokens[i + 1];
      if (!inline || inline.type !== 'inline') continue;

      let id = null;
      const m = inline.content.match(EXPLICIT);
      if (m) {
        id = m[1];
        inline.content = inline.content.replace(EXPLICIT, '');
        // The explicit marker also lives in the inline children; strip it there
        // or it renders as visible `{#notify}` text in the heading.
        const last = inline.children && inline.children[inline.children.length - 1];
        if (last && last.type === 'text') last.content = last.content.replace(EXPLICIT, '');
      } else {
        id = slugify(inline.content);
      }

      // A duplicate id makes one of two anchors unreachable with no error.
      let unique = id, n = 2;
      while (seen.has(unique)) unique = `${id}-${n++}`;
      seen.add(unique);

      tok.attrSet('id', unique);
      tok.meta = { ...(tok.meta || {}), id: unique, explicit: !!m };
    }
  });
}
