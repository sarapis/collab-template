import { parseAttrs } from './attrs.js';

// The `:::question{...}` container.
//
// Authored INLINE, inside the section it is about, so the anchor is implicit.
// GMTools names an element id in a separate catalog, and an anchor naming an id
// the document does not declare renders the question NOWHERE -- no error --
// while it still lists on the worksheet. Two views disagree and only one looks
// wrong. Writing the question where it belongs makes that unrepresentable.
export function questionContainer(md, collector) {
  md.use(containerPlugin, 'question', {
    validate: (params) => /^question(\s|\{|$)/.test(params.trim()),
    render: () => '', // rendering happens in a second pass, once numbers exist
  });
  collector.md = md;
}

// A minimal ::: container rule. Deliberately not markdown-it-container: this
// package is the piece that has to run inside other people's builds, so its
// dependency list is a cost other teams pay.
function containerPlugin(md, name, opts) {
  const marker = ':'.charCodeAt(0);
  const minMarkers = 3;

  md.block.ruler.before('fence', 'container_' + name, (state, startLine, endLine, silent) => {
    let pos = state.bMarks[startLine] + state.tShift[startLine];
    let max = state.eMarks[startLine];
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    if (marker !== state.src.charCodeAt(pos)) return false;

    let count = 0;
    while (pos < max && state.src.charCodeAt(pos) === marker) { pos++; count++; }
    if (count < minMarkers) return false;

    const params = state.src.slice(pos, max).trim();
    if (!opts.validate(params)) return false;
    if (silent) return true;

    let nextLine = startLine, closed = false;
    while (nextLine < endLine) {
      nextLine++;
      if (nextLine >= endLine) break;
      let p = state.bMarks[nextLine] + state.tShift[nextLine];
      const m = state.eMarks[nextLine];
      if (p < m && state.sCount[nextLine] < state.blkIndent) break;
      if (marker !== state.src.charCodeAt(p)) continue;
      if (state.sCount[nextLine] - state.blkIndent >= 4) continue;
      let c = 0;
      while (p < m && state.src.charCodeAt(p) === marker) { p++; c++; }
      if (c < count) continue;
      p = state.skipSpaces(p);
      if (p < m) continue;
      closed = true;
      break;
    }

    const oldParent = state.parentType, oldLineMax = state.lineMax;
    state.parentType = 'container';
    state.lineMax = nextLine;

    const open = state.push('container_' + name + '_open', 'aside', 1);
    open.markup = ':'.repeat(count);
    open.block = true;
    open.info = params;
    open.map = [startLine, nextLine];

    state.md.block.tokenize(state, startLine + 1, nextLine);

    const close = state.push('container_' + name + '_close', 'aside', -1);
    close.markup = state.src.slice(startLine, pos);
    close.block = true;

    state.parentType = oldParent;
    state.lineMax = oldLineMax;
    state.line = nextLine + (closed ? 1 : 0);
    return true;
  });
}

// Walk a parsed token stream: pair each question with the heading it sits
// under, and slice out its body tokens.
export function collectQuestions(tokens, docSlug) {
  const found = [];
  let section = null, sectionTitle = null;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.type === 'heading_open') {
      section = tok.meta?.id || tok.attrGet('id') || null;
      sectionTitle = tokens[i + 1]?.content?.trim() || null;
      continue;
    }

    if (tok.type !== 'container_question_open') continue;

    const attrs = parseAttrs(tok.info.replace(/^question/, ''));
    let depth = 1, j = i + 1;
    while (j < tokens.length && depth > 0) {
      if (tokens[j].type === 'container_question_open') depth++;
      if (tokens[j].type === 'container_question_close') depth--;
      if (depth === 0) break;
      j++;
    }

    found.push({
      attrs,
      doc: docSlug,
      section,
      sectionTitle,
      line: tok.map ? tok.map[0] + 1 : null,
      bodyTokens: tokens.slice(i + 1, j),
      openIndex: i,
      closeIndex: j,
    });
    i = j;
  }
  return found;
}

// `**Why asked:** ...` is a FIELD, not a comment. Most of the value in the
// GMTools catalog is the commentary explaining why a question is worded as it
// is, and moving a catalog from code to data is exactly where that gets lost.
const WHY = /<p><strong>Why asked:<\/strong>([\s\S]*?)<\/p>\s*/i;

export function splitWhy(html) {
  const m = html.match(WHY);
  if (!m) return { body: html.trim(), why: null };
  return { body: html.replace(WHY, '').trim(), why: m[1].trim() };
}
