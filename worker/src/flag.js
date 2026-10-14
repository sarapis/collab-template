// Reading a boolean out of the environment.
//
// ⚠️ Trimmed, because `echo true | wrangler secret put X` stores "true\n" and a
// strict === 'true' then rejects it silently. The switch looks set, the feature
// stays off, and nothing anywhere says why. Every flag in this Worker goes
// through here for that one reason.
export function flag(env, name) {
  return String(env?.[name] ?? '').trim().toLowerCase() === 'true';
}
