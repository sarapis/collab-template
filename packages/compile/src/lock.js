// questions.lock -- frozen numbers.
//
// A number is assigned once and never reused. Positional numbering renumbers
// everything after any insertion and silently invalidates every reference
// anyone wrote down, which is the worst failure available to an identifier.
//
// A retired question KEEPS its number and is marked retired. The resulting gap
// in the sequence is not damage -- it is the readable sign that something was
// removed, and it is why "Q22" in a six-month-old email still means one thing.
export function reconcileLock(existing, slugs) {
  const lock = { version: 1, numbers: { ...(existing?.numbers || {}) }, retired: { ...(existing?.retired || {}) } };
  const present = new Set(slugs);

  let max = 0;
  for (const n of Object.values(lock.numbers)) max = Math.max(max, n);

  const assigned = [];
  for (const slug of slugs) {
    if (lock.retired[slug] !== undefined) {
      // Came back. Give it its original number rather than a new one: the old
      // references were about this question and are still about this question.
      lock.numbers[slug] = lock.retired[slug];
      delete lock.retired[slug];
    }
    if (lock.numbers[slug] === undefined) {
      lock.numbers[slug] = ++max;
      assigned.push({ slug, number: lock.numbers[slug] });
    }
  }

  const retiredNow = [];
  for (const slug of Object.keys(lock.numbers)) {
    if (!present.has(slug)) {
      lock.retired[slug] = lock.numbers[slug];
      delete lock.numbers[slug];
      retiredNow.push(slug);
    }
  }

  return { lock, assigned, retiredNow };
}

export function serializeLock(lock) {
  // Sorted by number so a diff shows an append, not a reshuffle. A lock file
  // whose diff is noise stops being reviewed, and this file exists to be
  // reviewed.
  const bynum = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => a[1] - b[1]));
  return JSON.stringify({ version: lock.version, numbers: bynum(lock.numbers), retired: bynum(lock.retired) }, null, 2) + '\n';
}
