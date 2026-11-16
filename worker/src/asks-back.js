// An answer that asks a question back (v1.16.0).
//
// It is still an answer: on the record, edited like any other, quotable. But it
// does not settle its question. "Not sure what this means" and "what is the key
// used for?" were counted as answers, so questions that had only been asked
// back looked answered, sat in "ready to fold", and left everyone's lists.
//
// The rule, in one place for every counter (the notifications, the MCP tools,
// and the widget's filters, which mirror it in collab.js):
//
//   a question's state comes from its answers in the CURRENT round only;
//   none                              -> unanswered
//   the newest one asks back          -> needs a reply
//   otherwise                         -> answered
//
// The person who asked back has done their part, so the question stops waiting
// for THEM: that rule (waitingFor in band.js, answeredByMe in index.js) counts
// every answer of theirs, flagged or not, and is deliberately left alone.
//
// ⚠️ Stored beside the answers, not as a column. worker/schema.sql runs on every
// deploy and may only CREATE ... IF NOT EXISTS, and SQLite has no ADD COLUMN IF
// NOT EXISTS (test/schema-idempotent.test.js).

export async function asksBackIds(env) {
  const { results } = await env.DB.prepare('SELECT answer_id FROM answer_asks_back').all()
    .catch(() => ({ results: [] }));
  return new Set((results || []).map((r) => r.answer_id));
}

export async function setAsksBack(env, answerId, on, me) {
  if (on) {
    await env.DB.prepare('INSERT INTO answer_asks_back (answer_id, set_by, set_at) VALUES (?, ?, ?) ON CONFLICT(answer_id) DO NOTHING')
      .bind(answerId, me.sub, new Date().toISOString()).run();
  } else {
    await env.DB.prepare('DELETE FROM answer_asks_back WHERE answer_id = ?').bind(answerId).run();
  }
}

// `answers`: this question's answers ({id, created_at}); `flagged`: asksBackIds();
// `opened`: when the question's current round opened.
export function answerState(answers, flagged, opened) {
  const current = (answers || []).filter((a) => a.created_at >= opened)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  if (!current.length) return 'unanswered';
  return flagged.has(current[current.length - 1].id) ? 'needs-reply' : 'answered';
}
