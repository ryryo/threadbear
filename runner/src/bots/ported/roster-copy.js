// Extracted from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a,
// ds-bot/src/host/roster.js. Copyright 2026 Fei2411 and the DS Bot contributors.
// SPDX-License-Identifier: Apache-2.0
// The original functions use the owning Runner's roster and settings checks.
const COLORS = ['deepseek', 'blue', 'violet', 'orange', 'green', 'magenta', 'cyan', 'red', 'yellow', 'brown', 'gray', 'black', 'aurora']
const EXTRA_COLORS = ['charcoal', 'graphite', 'rose', 'sky', 'tangerine', 'cobalt']
const LEGACY_COLORS = { kimi: 'charcoal', zai: 'graphite', minimax: 'rose', stepfun: 'sky', mimo: 'tangerine', qwen: 'cobalt' }
const MAX_AVATAR_IMAGE = 160_000
const currentColor = color => (typeof color === 'string' && Object.hasOwn(LEGACY_COLORS, color) ? LEGACY_COLORS[color] : color)
const isColor = color => typeof color === 'string' && (COLORS.includes(color) || EXTRA_COLORS.includes(color) || /^#[0-9a-f]{6}$/i.test(color))

  function cleanAvatar(input) {
    if (input === null || typeof input !== 'object') return undefined
    const avatar = {}
    if (typeof input.shape === 'string' && /^[a-z][\w-]{0,31}$/.test(input.shape)) avatar.shape = input.shape
    if (typeof input.image === 'string') {
      if (!/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(input.image)) throw new Error('Avatar images must be PNG, JPEG, WebP, GIF, or SVG')
      if (input.image.length > MAX_AVATAR_IMAGE) throw new Error('Avatar image is too large')
      avatar.image = input.image
    }
    return Object.keys(avatar).length > 0 ? avatar : undefined
  }

export function copyAppearance({ color, avatar, sectionId }) {
  const cleanAvatarValue = cleanAvatar(avatar)
  return {
    ...(isColor(currentColor(color)) ? { color: currentColor(color) } : {}),
    ...(cleanAvatarValue ? { avatar: cleanAvatarValue } : {}),
    ...(typeof sectionId === 'string' && sectionId ? { sectionId } : {}),
  }
}

export function rosterCopy({ liveBot, botNameTaken, rt, createBot }) {
  const freshName = (base) => {
    const stem = base.slice(0, 34)
    if (!botNameTaken(stem)) return stem
    let index = 2
    while (botNameTaken(`${stem} ${index}`)) index += 1
    return `${stem} ${index}`
  }

  async function duplicateBot(id) {
    const bot = liveBot(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (bot.private === true) throw new Error(`${bot.name} is private, so it cannot be copied`)
    const served = (await rt.catalog()).some(entry => entry.ref === bot.model)
    // A folder that went away since leaves the copy in the team workspace.
    const workDir = bot.workDir !== undefined && await rt.isFolder(bot.workDir) ? bot.workDir : undefined
    // No await from here to createBot's check, so two copies at once get different names.
    return createBot({
      name: freshName(`${bot.name} copy`),
      role: bot.role,
      instructions: bot.instructions,
      color: bot.color,
      avatar: bot.avatar,
      model: served ? bot.model : undefined,
      // A copy of a Bot on the model's own default stays on it (null marks the
      // explicit Default pick); else the create would inherit the profile level.
      effort: served ? (bot.effort ?? null) : undefined,
      workDir,
      sectionId: bot.sectionId,
      copyOf: bot.id,
    })
  }

  return duplicateBot
}
