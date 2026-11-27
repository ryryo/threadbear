// DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a. Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { paintCss } from './inks.mjs'
import { CHARACTERS, PICKER_SHAPES, PICKER_COLUMNS, CHARACTER_COLORS, SHAPES, hasShape, shapeOf, bodyOf, maskBox, holes, nextMarkSerial } from './characters.mjs'
import { lookOf, BotMark } from './avatar-mark.mjs'
import { avatarImage } from './avatar-upload.mjs'
import { useGlide, useLinger } from './motion.mjs'
import { t } from './avatar-i18n.mjs'

const capitalize = word => word[0].toUpperCase() + word.slice(1)

const lineIcon = paths => function LineIcon() {
  return h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    paths.map((d, index) => h('path', { key: index, d })))
}
export const PencilIcon = lineIcon(['M9 4H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3', 'M14.3 3.7a1.6 1.6 0 0 1 2.3 2.3L10.5 12l-3 .8.8-3z'])

// The selection ring of a picker cell follows the shape: a 1px line 3px outside it.
function ShapeRing({ shape, size }) {
  const maskId = useRef('')
  if (maskId.current === '') maskId.current = `bt-ring-${nextMarkSerial()}`
  const def = shapeOf(shape)
  const unit = def.size / size
  const markup = `<defs><mask id="${maskId.current}" ${maskBox(def.size)}>${holes(def, `<g stroke="#000" stroke-width="${6 * unit}" stroke-linejoin="round">${bodyOf(def, '#000', true)}</g>`)}</mask></defs><g mask="url(#${maskId.current})" stroke="currentColor" stroke-width="${8 * unit}" stroke-linejoin="round">${bodyOf(def, 'currentColor', true)}</g>`
  return h('svg', { className: 'bt-ring', viewBox: `0 0 ${def.size} ${def.size}`, 'aria-hidden': true, dangerouslySetInnerHTML: { __html: markup } })
}

// Every character shape, six to a row, then the color swatches.
export function CharacterGrid({ look, hasPhoto = false, onShape, onColor }) {
  const shapes = [...PICKER_SHAPES, ...Object.keys(SHAPES).filter(id => !Object.hasOwn(CHARACTERS, id))]
  if (!shapes.includes(look.shape)) shapes.push(look.shape)
  const rows = []
  for (let index = 0; index < shapes.length; index += PICKER_COLUMNS) rows.push(shapes.slice(index, index + PICKER_COLUMNS))
  return h(Fragment, null,
    h('div', { className: 'bt-shapes', role: 'group', 'aria-label': t('Character shape') }, rows.map((row, index) => h('div', { key: index, className: 'bt-shape-row' }, row.map(id => h('button', {
      key: id, type: 'button', className: 'bt-shape', 'aria-label': t(shapeOf(id).label), title: t(shapeOf(id).label), 'aria-pressed': !hasPhoto && look.shape === id,
      onClick: () => onShape(id),
    }, h(ShapeRing, { shape: id, size: 36 }), h(BotMark, { look: { shape: id, color: look.color }, size: 36 })))))),
    h('div', { className: 'bt-colors', role: 'group', 'aria-label': t('Character color') }, CHARACTER_COLORS.map(color => h('button', {
      key: color, type: 'button', className: 'bt-color', 'aria-label': t(capitalize(color)), title: t(capitalize(color)), 'aria-pressed': look.color === color,
      onClick: () => onColor(color),
    }, h('span', { style: { background: paintCss(color) } })))))
}

// The avatar editor: the Bot tab picks a character (every click saves), the
// Upload tab takes a photo. Reset returns to the look the Bot id gives.
function AvatarEditor({ bot, actions, run, onClose, leaving = false }) {
  const look = lookOf(bot)
  const [tab, setTab] = useState(look.image ? 'upload' : 'bot')
  const [over, setOver] = useState(false)
  const ref = useRef(null)
  const fileRef = useRef(null)
  const upload = (file) => {
    if (file) void run(avatarImage(file).then(image => actions.updateBot(bot.id, { avatar: { ...(bot.avatar ?? {}), image } })))
  }
  useEffect(() => {
    const onDown = (event) => {
      if (!(event.target instanceof Element) || ref.current?.contains(event.target) || event.target.closest('.bt-avatar-trigger')) return
      onClose()
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [onClose])
  useEffect(() => {
    if (tab !== 'upload') return undefined
    const onPaste = (event) => {
      const file = [...(event.clipboardData?.files ?? [])].find(item => item.type.startsWith('image/'))
      if (file) { event.preventDefault(); upload(file) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [tab, bot])
  const hasPhoto = Boolean(look.image)
  const glide = useGlide(tab)
  return h('div', { ref, className: 'bt-avedit', role: 'dialog', 'aria-label': t('Avatar editor'), 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-avedit-top' },
      h('div', { ref: glide.box, role: 'tablist', 'aria-label': t('Avatar source'), className: 'bt-avedit-tabs' },
        h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }),
        [['bot', 'Bot'], ['upload', 'Upload']].map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab', className: 'bt-avedit-tab', 'aria-selected': tab === id, onClick: () => setTab(id) }, t(label)))),
      h('button', {
        type: 'button', className: 'bt-avedit-tab bt-avedit-reset', title: t('Reset character to default'),
        onClick: () => run(actions.updateBot(bot.id, { avatar: null, color: null })),
      }, t('Reset'))),
    tab === 'bot' ? h(CharacterGrid, {
      look, hasPhoto,
      onShape: shape => run(actions.updateBot(bot.id, { avatar: { shape } })),
      onColor: color => run(actions.updateBot(bot.id, { color })),
    }) : null,
    tab === 'upload' ? h('div', {
      className: 'bt-dropzone', 'data-over': over || undefined,
      onDragOver: (event) => { event.preventDefault(); setOver(true) },
      onDragLeave: () => setOver(false),
      onDrop: (event) => { event.preventDefault(); setOver(false); upload(event.dataTransfer.files?.[0]) },
    },
    hasPhoto ? h('img', { src: look.image, alt: '' }) : null,
    h('div', null, t('Drag, drop, or paste an image')),
    h('div', { className: 'bt-actions', style: { justifyContent: 'center' } },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => fileRef.current?.click() }, hasPhoto ? t('Replace') : t('Browse files')),
      hasPhoto ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.updateBot(bot.id, { avatar: hasShape(bot.avatar?.shape) ? { shape: bot.avatar.shape } : null })) }, t('Remove photo')) : null),
    h('input', { ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; upload(file) } })) : null)
}

export function AvatarHeader({ bot, actions, run }) {
  const [editing, setEditing] = useState(false)
  const [editorShown, editorLeaving] = useLinger(editing, 120)
  const closeEditor = useCallback(() => setEditing(false), [])
  return h('div', { className: 'bt-bs-hero' },
      h('div', { className: 'bt-avatar-anchor' },
        h('button', { type: 'button', className: 'bt-avatar-trigger', 'aria-label': t('Edit Bot avatar'), 'aria-expanded': editing, onClick: () => setEditing(value => !value) },
          h(BotMark, { bot, size: 64, live: true }),
          h('span', { className: 'bt-avatar-pencil', 'aria-hidden': true }, h(PencilIcon))),
        editorShown ? h(AvatarEditor, { bot, actions, run, onClose: closeEditor, leaving: editorLeaving }) : null),
      h('div', { className: 'bt-bs-who' },
        h('span', { className: 'bt-bs-name' }, bot.name),
        h('span', { className: 'bt-bs-sub' }, bot.role || t('Bot'))))
}
