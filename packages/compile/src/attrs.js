// `{slug=notify-cadence audience=devin margin=false}` -> object.
// Values may be quoted. Unknown keys are returned as-is so the caller decides
// what is an error: a silent drop here would make a typo look like a default.
export function parseAttrs(raw) {
  const out = {};
  if (!raw) return out;
  const re = /([A-Za-z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s}]+)/g;
  let m;
  while ((m = re.exec(raw))) {
    out[m[1]] = m[3] ?? m[4] ?? m[2];
  }
  return out;
}
