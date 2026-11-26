// Roster rules adapted from DS-Bot src/host/roster.js, d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0 (see ported/NOTICE).
type Member = { id: string; name: string; private?: boolean };

export function setChief(
  chiefBotIds: readonly string[],
  bot: Member | undefined,
  main: boolean,
  { primary = false, replace }: { primary?: boolean; replace?: string } = {},
): string[] {
  if (bot === undefined) throw new Error('Unknown Bot')
  const id = bot.id
  if (main && bot.private === true) throw new Error(`${bot.name} is private, so it cannot be a Chief`)
  const others = chiefBotIds.filter(other => other !== id)
  let next: string[]
  if (!main) {
    if (!chiefBotIds.includes(id)) return [...chiefBotIds]
    if (others.length === 0) throw new Error('The team needs at least one Chief')
    next = others
  } else if (replace !== undefined && replace !== id) {
    const at = others.indexOf(replace)
    if (at === -1) throw new Error('Only a Chief can be replaced')
    next = others.with(at, id)
  } else if (primary) {
    next = [id, ...others]
  } else {
    next = chiefBotIds.includes(id) ? [...chiefBotIds] : [...others, id]
  }
  return next
}
