// DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a. Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { fnv1a, lookOf, shapeId, shapeOf, MASK_ID, nextMarkSerial, characterMarkup } from './characters.mjs'
import { reducedEffects, reducedMotion } from './motion.mjs'

export { colorOf, lookOf } from './characters.mjs'

// -------------------------------------------------------------------------
// Bot mark: the Bot's character (or its uploaded photo), looked up by lookOf.

// Mascot states: what the Bot is doing picks the
// motion. Uploaded images only bob or hop, since they have no parts to move. `waiting`:
// no turn runs, but work it handed on has not come back yet.
const STATES = ['idle', 'thinking', 'searching', 'working', 'sending', 'orbit', 'waiting', 'alert', 'done']
export const botState = (running, activity, alert) => (running ? (STATES.includes(activity) && activity !== 'waiting' ? activity : 'working')
  : alert ? 'alert' : activity === 'waiting' ? 'waiting' : 'idle')
export const toolState = name => (/^(message_bot|stop_bot|create_bot|update_bot|create_group|update_group|delete_group|post_to_group)$/.test(name) ? 'sending'
  : /search|fetch|browse|read|grep|glob|list|recall/i.test(name) ? 'searching' : 'working')

// Eyes follow the pointer on large marks.
function useGaze(ref, enabled) {
  useEffect(() => {
    if (!enabled) return undefined
    let frame = 0
    let point = null
    let active = false
    const clear = () => {
      point = null
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      ref.current?.style.removeProperty('--bt-gx')
      ref.current?.style.removeProperty('--bt-gy')
    }
    const place = () => {
      frame = 0
      const node = ref.current
      if (!node || !point || reducedEffects()) return
      const box = node.getBoundingClientRect()
      const clamp = value => Math.max(-1, Math.min(1, value))
      node.style.setProperty('--bt-gx', clamp((point.x - box.left - box.width / 2) / 160).toFixed(2))
      node.style.setProperty('--bt-gy', clamp((point.y - box.top - box.height / 2) / 160).toFixed(2))
    }
    const onMove = (event) => {
      if (reducedEffects() || document.body?.dataset.btMotion === 'quiet') return
      point = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(place)
    }
    const onLeave = () => { point = null; ref.current?.style.setProperty('--bt-gx', '0'); ref.current?.style.setProperty('--bt-gy', '0') }
    const attach = () => {
      if (active) return
      active = true
      window.addEventListener('pointermove', onMove, { passive: true })
      document.documentElement.addEventListener('pointerleave', onLeave)
    }
    const detach = () => {
      if (!active) return
      active = false
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      clear()
    }
    const sync = () => { if (reducedEffects() || document.body?.dataset.btMotion === 'quiet') detach(); else attach() }
    sync()
    const observer = typeof MutationObserver === 'function' && document.body ? new MutationObserver(sync) : null
    observer?.observe(document.body, { attributes: true, attributeFilter: ['data-bt-effects', 'data-bt-motion'] })
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    media?.addEventListener?.('change', sync)
    return () => {
      observer?.disconnect()
      media?.removeEventListener?.('change', sync)
      detach()
    }
  }, [enabled])
}

// A mark moves for its state. `live` marks (sidebar, header, details) also answer the
// pointer, and at the lively motion level blink and fidget at rest (each Bot its own
// fidget and moment); transcript marks stay still so a long chat does not run dozens
// of animations.
const FIDGETS = ['hop', 'sway', 'stretch', 'look']
export function BotMark({ bot, look: given, size = 36, state = 'idle', live = false, gaze = false, pokeable = false, label }) {
  const look = given ?? lookOf(bot)
  const ref = useRef(null)
  const maskId = useRef('')
  if (maskId.current === '') maskId.current = `bt-mark-${nextMarkSerial()}`
  const [poked, setPoked] = useState(false)
  // A photo that does not load shows the character instead; a new photo is tried again.
  const [broken, setBroken] = useState('')
  const image = look.image && look.image !== broken ? look.image : undefined
  useGaze(ref, gaze && !image)
  const common = {
    ref,
    className: poked ? 'bt-mark bt-mark-poke' : 'bt-mark',
    'data-shape': image ? 'image' : shapeId(look.shape),
    'data-state': STATES.includes(state) ? state : 'idle',
    'data-live': live ? '' : undefined,
    'data-fidget': live ? FIDGETS[fnv1a(`${bot?.id ?? ''}:fidget`) % FIDGETS.length] : undefined,
    'data-gaze': gaze && !image ? '' : undefined,
    'data-poke': pokeable ? '' : undefined,
    style: { width: size, height: size, ...(live ? { '--bt-delay': `${-(fnv1a(String(bot?.id ?? '')) % 5000) / 1000}s`, '--bt-fidget-delay': `${-(fnv1a(`${bot?.id ?? ''}:when`) % 9000) / 1000}s` } : {}) },
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
    onClick: pokeable ? () => { if (!reducedMotion() && document.body?.dataset.btMotion !== 'quiet') setPoked(true) } : undefined,
    onAnimationEnd: poked ? (event) => { if (event.animationName.startsWith('bt-poke')) setPoked(false) } : undefined,
    onAnimationCancel: poked ? () => setPoked(false) : undefined,
  }
  if (image) return h('span', common, h('img', { className: 'bt-mark-img', src: image, alt: '', draggable: false, onError: () => setBroken(image) }))
  const box = shapeOf(look.shape).size
  return h('span', common, h('svg', { viewBox: `0 0 ${box} ${box}`, dangerouslySetInnerHTML: { __html: characterMarkup(look.shape, look.color).replaceAll(MASK_ID, maskId.current) } }))
}
