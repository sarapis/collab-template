// One length limit, every path that stores somebody's words.
//
// Answers, comments and chat turns were bounded only by `.trim()` and D1's row
// limit. Writes are roster-only on both instances, so the exposure is a handful
// of trusted people and this was filed LOW in the 2026-09-18 review — but a
// bound nobody wrote is a bound nobody can point at, and the chat path also
// forwards the body to a paid API.
//
// ⚠️ Over the limit is REFUSED, never truncated. The review note suggested a
// `slice()`, and this project has already been bitten once by a prefix: a
// published quote turned out to be the first half of an answer, and the half it
// cut carried the requirement. Truncating on write is that failure with nobody
// in the loop at all — the author is told the write succeeded and the missing
// half exists nowhere. A refusal is visible, and the words are still in the box
// the person typed them into.
//
// ⚠️ The number is far past any real answer and far short of anything that
// costs the store or the model provider something. The longest answer written
// here is under a thousand characters; this is room for twenty of them. If it
// ever refuses a real answer, raise it — do not start truncating.
export const MAX_BODY = 20000;

/**
 * The single refusal message, so an answer, a comment and a chat turn all say
 * the same thing and all say what to do about it.
 *
 * Returns an error string, or null when the text fits.
 */
export function overLimit(text, max = MAX_BODY) {
  const n = String(text ?? '').length;
  return n > max
    ? `too long: ${n} characters, and the limit is ${max}. Nothing was saved — shorten it and post again, or split it into two.`
    : null;
}
