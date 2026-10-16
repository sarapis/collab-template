// Who a question is WAITING ON (HOST-CONTRACT.md, "Addressing"; v1.11.0).
//
// A question with `to=` waits on those addressees; one without waits on its
// audience, which is how this host has always read the audience. So a site that
// never writes `to=` behaves exactly as before, and one that does can keep its
// audiences for VISIBILITY (as Databook must) while `to=` says whose turn it is.
// Every place that asks "is this waiting on you?" or "on whom?" asks here.

export function waitsOn(q) {
  return Array.isArray(q?.to) && q.to.length ? q.to : [q?.audience].filter(Boolean);
}

export function waitsOnAny(q, groups) {
  const mine = new Set(groups || []);
  return waitsOn(q).some((g) => mine.has(g));
}

// A group's display name and meaning: an addressee's, else an audience's, else the key.
export function groupName(m, key) {
  return m?.addressees?.[key]?.name || m?.audiences?.[key]?.name || key;
}

export function groupDescribes(m, key) {
  return m?.addressees?.[key]?.describes || m?.audiences?.[key]?.describes || '';
}

// Every group a person can belong to: the declared audiences, then the addressees
// not already among them, in the order site.config.yml gives.
export function declaredGroups(m) {
  const out = new Map();
  for (const [id, a] of Object.entries(m?.audiences || {})) out.set(id, { id, name: a?.name || id, describes: a?.describes || '' });
  for (const [id, a] of Object.entries(m?.addressees || {}))
    if (!out.has(id)) out.set(id, { id, name: a?.name || id, describes: a?.describes || '' });
  return [...out.values()];
}

// Open questions per group they wait on, most first (the About page's cards).
export function openByGroup(questions) {
  const counts = new Map();
  for (const q of questions || []) {
    if (q.resolved || q.hidden) continue;
    for (const g of waitsOn(q)) counts.set(g, (counts.get(g) || 0) + 1);
  }
  return [...counts.entries()].map(([audience, count]) => ({ audience, count })).sort((a, b) => b.count - a.count);
}
