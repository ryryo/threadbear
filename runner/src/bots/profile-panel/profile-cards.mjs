// DS-Bot settings, d104d9ca18d69a35460f14e15dff4d553181433a. Extracted from bot-settings.js.
// InlineText carries the edit-version check for late saves. Row and Card are copied unchanged.
import { createElement as h, useEffect, useRef, useState } from 'react';
import { useMemoryCount } from './memory-count.mjs';

export function InlineText({ label, value, placeholder, required = false, maxLength, multiline = false, className, autoFocus = false, onSave, onDone }) {
  const [draft, setDraft] = useState(null)
  const reverting = useRef(false)
  const editVersion = useRef(0)
  const field = useRef(null)
  useEffect(() => {
    const node = field.current
    if (!autoFocus || !node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [])
  const commit = () => {
    const submittedVersion = ++editVersion.current
    const next = draft?.trim()
    if (reverting.current) { reverting.current = false; setDraft(null); onDone?.(); return }
    if (next === undefined || next === (value ?? '') || (required && next === '')) {
      setDraft(null)
      onDone?.()
      return
    }
    const finish = (ok) => {
      if (ok === false || submittedVersion !== editVersion.current) return
      setDraft(null)
      onDone?.()
    }
    const outcome = onSave(next)
    if (outcome && typeof outcome.then === 'function') {
      void outcome.then(finish, () => {})
    } else {
      finish(outcome)
    }
  }
  return h(multiline ? 'textarea' : 'input', {
    ref: field, className: className ?? (multiline ? 'bt-bs-input bt-bs-area' : 'bt-bs-input'), value: draft ?? value ?? '', placeholder, maxLength, required, 'aria-label': label, spellCheck: false,
    onChange: event => {
      editVersion.current += 1
      setDraft(event.target.value)
    },
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === 'Escape' && !event.nativeEvent?.isComposing && event.keyCode !== 229) {
        event.preventDefault?.()
        event.stopPropagation?.()
        event.nativeEvent?.stopPropagation?.()
        reverting.current = true
        event.currentTarget.blur()
      }
      if (event.key === 'Enter' && !multiline && !event.nativeEvent?.isComposing && event.keyCode !== 229) event.currentTarget.blur()
    },
  })
}

export function Row({ label, hint, stack = false, children }) {
  return h('label', { className: stack ? 'bt-set-row bt-bs-row bt-bs-stack' : 'bt-set-row bt-bs-row' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children)
}

export function Card({ title, children }) {
  return h('section', { className: 'bt-set-section' }, title ? h('h3', null, title) : null, h('div', { className: 'bt-set-card' }, children))
}

export const ChevronRightIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M7.5 4.5L13 10l-5.5 5.5' }))

function MemoryCard({ bot, actions, t }) {
  const count = useMemoryCount(bot.id, actions)
  const label = count === null ? t('Loading…') : count === 0 ? t('Nothing saved yet') : count === 1 ? t('1 entry') : t('{count} entries', { count })
  return h(Card, { title: t('Memory') },
    h('button', { type: 'button', className: 'bt-set-row bt-bs-row', 'aria-label': t("Manage {name}'s memory", { name: bot.name }), onClick: () => actions.openMemory(bot.id) },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, label)),
      h('span', { className: 'bt-mem-row-go' }, t('Manage'), h(ChevronRightIcon))))
}

export function BotProfileCards({ bot, actions, t }) {
  const save = patch => actions.updateBot(bot.id, patch);
  return h('div', { className: 'bt-bs' },
    h(Card, { title: t('Profile') },
      h(Row, { label: t('Name') }, h(InlineText, { label: t('Name'), value: bot.name, placeholder: 'Bob', required: true, maxLength: 40, onSave: name => save({ name }) })),
      h(Row, { label: t('Label'), hint: t('Optional. Shown under the name.') }, h(InlineText, { label: t('Label'), value: bot.role, placeholder: t('Research, admin…'), maxLength: 24, onSave: role => save({ role }) }))),
    h(Card, { title: t('Instructions') },
      h(Row, { label: t('What this Bot does'), hint: t('Its job on the team. Part of the Bot\'s system prompt.'), stack: true },
        h(InlineText, { label: t('Instructions'), value: bot.instructions, multiline: true, placeholder: t('What this Bot is responsible for…'), onSave: instructions => save({ instructions }) }))),
    actions.memoryView ? h(MemoryCard, { bot, actions, t }) : null
  );
}
