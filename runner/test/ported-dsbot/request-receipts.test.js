// Derived from DS-Bot’s request-id.test.js. Apache-2.0, Fei2411 and contributors.
import assert from "node:assert/strict"
import { test } from "node:test"
import { install as installRequests } from "../../src/bots/ported/requests.js"

test('old identities survive age and receipt volume without permitting another delivery', async () => {
  const rt = { state: {}, own: (object, key) => Object.hasOwn(object, key) ? object[key] : undefined, readOnly: () => undefined, save: async () => {}, warn() {} }
  installRequests(rt)
  const original = rt.requestIdentity({ caller: 'a', context: 'chat', name: 'original', payload: { message: 'do it' } })
  await rt.admitRequest(original, async () => 'first receipt')
  rt.state.requests[original.key].at = 0
  for (let i = 0; i < 2001; i += 1) rt.state.requests[`other-${i}`] = { at: i, outcome: 'delivered', fingerprint: 'x', receipt: 'kept' }
  const fresh = rt.requestIdentity({ caller: 'a', context: 'chat', name: 'fresh', payload: { message: 'next' } })
  await rt.admitRequest(fresh, async () => 'next receipt')
  const result = await rt.admitRequest(original, async () => { throw new Error('duplicate delivery') })
  assert.deepEqual(result, { status: 'replay', receipt: 'first receipt' })
})
