// DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a, memory-panel.js.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
import { useEffect, useState } from 'react';

const counts = new Map()
const countListeners = new Set()
function noteCount(id, count) {
  if (counts.get(id) === count) return
  counts.set(id, count)
  for (const listener of countListeners) listener()
}

export function useMemoryCount(id, actions) {
  const [count, setCount] = useState(counts.get(id) ?? null)
  useEffect(() => {
    const listener = () => setCount(counts.get(id) ?? null)
    countListeners.add(listener)
    listener()
    let stop = false
    actions.memoryView?.(id).then((view) => { if (!stop) noteCount(id, view.entries.length) }).catch(() => {})
    return () => { stop = true; countListeners.delete(listener) }
  }, [id])
  return count
}
