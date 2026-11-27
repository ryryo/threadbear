// Seven original DS-Bot storage tests from 08f1f54d83f0a2f9bd44686885d0b10c521fd87b at d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
// The startup adapter points the original storage tests at the Threadbear port.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../../src/bots/ported/avatar-library.js'
// Only the magic bytes matter to the reader; the rest of a fixture need not decode.
const file = (magic, size = 32) => Buffer.concat([magic, Buffer.alloc(size, 7)])
const PNG = file(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const JPEG = file(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
const asDataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`
const pngUrl = asDataUrl('image/png', PNG)
const jpegUrl = asDataUrl('image/jpeg', JPEG)


function start(home) {
  const rt = { home }
  install(rt)
  return {
    stop: async () => {},
    async call(endpoint, payload) {
      switch (endpoint) {
        case 'avatar-import': return { ok: true, value: await rt.avatarLibraryImport(payload.items) }
        case 'avatar-library': return { ok: true, value: await rt.avatarLibraryView(payload) }
        case 'avatar-delete': return { ok: true, value: await rt.avatarLibraryDelete(payload.id) }
        default: throw new Error('Unexpected original test endpoint')
      }
    },
  }
}
const makeHome = () => realpathSync(mkdtempSync(join(tmpdir(), 'ds-bot-avlib-')))

test('an image whose index write failed is not treated as an imported duplicate', async (t) => {
  const home = makeHome()
  const { call, stop } = start(home)
  t.after(async () => { await stop(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const index = join(home, 'avatars', 'index.json')
  mkdirSync(index, { recursive: true })
  const result = (await call('avatar-import', { items: [{ name: 'first.png', image: pngUrl }, { name: 'again.png', image: pngUrl }] })).value
  assert.equal(result.failed.length, 2)
  assert.equal(result.imported.length, 0)
  assert.equal(result.duplicates.length, 0)
  assert.equal((await call('avatar-library', {})).value.total, 0)
  rmSync(index, { recursive: true })
  const retry = (await call('avatar-import', { items: [{ name: 'first.png', image: pngUrl }, { name: 'again.png', image: pngUrl }] })).value
  assert.equal(retry.imported.length, 1)
  assert.equal(retry.duplicates.length, 1)
  assert.equal((await call('avatar-library', {})).value.total, 1)
})


test('a photo imported once is kept, and the same photo again does not make a second entry', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  const first = await call('avatar-import', { items: [{ name: 'team.png', image: pngUrl }] })
  assert.equal(first.ok, true)
  assert.equal(first.value.imported.length, 1)
  assert.equal(first.value.duplicates.length, 0)
  assert.equal(first.value.failed.length, 0)

  const library = (await call('avatar-library', {})).value
  assert.equal(library.items.length, 1)
  assert.equal(library.items[0].name, 'team.png')
  // The window gets the image itself, so it needs one request to draw the library.
  assert.equal(library.items[0].image, pngUrl)

  // The same picture again, even under another name, is the picture that is there.
  const again = await call('avatar-import', { items: [{ name: 'other.png', image: pngUrl }, { name: 'second.jpg', image: jpegUrl }] })
  assert.equal(again.value.imported.length, 1)
  assert.equal(again.value.duplicates.length, 1)
  assert.equal(again.value.duplicates[0].name, 'team.png')
  assert.equal(again.value.failed.length, 0)
  const after = (await call('avatar-library', {})).value
  assert.equal(after.items.length, 2)
  assert.deepEqual(after.items.map(item => item.name).sort(), ['second.jpg', 'team.png'])
})


test('a batch import partly succeeds: the good photos land, and the bad one is named', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  const result = await call('avatar-import', {
    items: [
      { name: 'one.png', image: pngUrl },
      { name: 'notes.png', image: 'data:image/png;base64,bm90IGFuIGltYWdl' },
      { name: 'two.jpg', image: jpegUrl },
    ],
  })
  assert.equal(result.value.imported.length, 2)
  assert.equal(result.value.failed.length, 1)
  assert.equal(result.value.failed[0].name, 'notes.png')
  assert.match(result.value.failed[0].message, /must be a PNG, JPEG, WebP, or GIF image/)
  // The photos that were read are kept, and the library shows them.
  const library = (await call('avatar-library', {})).value
  assert.deepEqual(library.items.map(item => item.name).sort(), ['one.png', 'two.jpg'])

  // An image over the limit is refused by name too.
  const huge = asDataUrl('image/png', Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(200_000)]))
  const over = await call('avatar-import', { items: [{ name: 'huge.png', image: huge }] })
  assert.equal(over.value.imported.length, 0)
  assert.equal(over.value.failed.length, 1)
  assert.match(over.value.failed[0].message, /too large/)
  assert.equal((await call('avatar-library', {})).value.items.length, 2)
})


test('the library files are named by their content, and none is left half-written', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  await call('avatar-import', { items: [{ name: 'team.png', image: pngUrl }] })
  const files = readdirSync(join(home, 'avatars', 'files'))
  assert.equal(files.length, 1)
  assert.match(files[0], /^[0-9a-f]{64}\.png$/)
  // The index and the images are written whole, so no temp file is left behind.
  assert.deepEqual(readdirSync(join(home, 'avatars')).sort(), ['files', 'index.json'])
})


test('imports that overlap all land, and none is lost to another one', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  // Ten imports at once: each reads the index and writes it back, so without a queue
  // the ones that overlap would drop each other's photos.
  const photos = Array.from({ length: 10 }, (_, index) => ({
    name: `photo-${index}.png`,
    image: asDataUrl('image/png', Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(index + 1, index + 1)])),
  }))
  const results = await Promise.all(photos.map(photo => call('avatar-import', { items: [photo] })))
  assert.equal(results.every(result => result.ok), true)
  const library = (await call('avatar-library', {})).value
  assert.equal(library.total, 10)
  assert.equal(library.items.length, 10)
  assert.deepEqual(library.items.map(item => item.name).sort(), photos.map(photo => photo.name).sort())
  // Every photo is on disk once, and the index names them all.
  assert.equal(readdirSync(join(home, 'avatars', 'files')).length, 10)
})


test('the library answers page by page, so a big library is not one huge reply', async (t) => {
  // A batch may import several images in the same millisecond.
  t.mock.method(Date, 'now', () => 1_800_000_000_000)
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  const photos = Array.from({ length: 60 }, (_, index) => ({
    name: `photo-${index}.png`,
    image: asDataUrl('image/png', Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(index + 1, index + 1)])),
  }))
  await call('avatar-import', { items: photos })

  const first = (await call('avatar-library', {})).value
  assert.equal(first.total, 60)
  assert.ok(first.items.length <= 48, `the first answer carries ${first.items.length} photos, not the whole library`)
  // The newest come first.
  assert.equal(first.items[0].name, 'photo-59.png')
  // The next page starts where this one stopped.
  assert.equal(first.next, first.items.length)

  // The next page continues where the first stopped, and the two do not overlap.
  const second = (await call('avatar-library', { offset: first.next, limit: 10 })).value
  assert.equal(second.items.length, 10)
  assert.equal(second.total, 60)
  assert.equal(second.next, first.next + 10)
  const names = new Set(first.items.map(item => item.name))
  assert.equal(second.items.every(item => !names.has(item.name)), true)
  // A page past the end is empty, not an error.
  assert.equal((await call('avatar-library', { offset: 60 })).value.items.length, 0)
})


test('a page reads at most 8 photos at once and keeps the newest-first order when reads finish out of order', { timeout: 5_000 }, async (t) => {
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now++)
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  const photos = Array.from({ length: 20 }, (_, index) => ({
    name: `photo-${index}.png`,
    image: asDataUrl('image/png', Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(index + 1, index + 1)])),
  }))
  const { imported } = (await call('avatar-import', { items: photos })).value
  const gone = new Set([3, 4, 11, 19])
  for (const index of gone) rmSync(join(home, 'avatars', 'files', `${imported[index].id}.png`))

  const { readFile } = fsp
  const photoFiles = join(home, 'avatars', 'files')
  let started = 0
  let reading = 0
  let peak = 0
  const firstWave = Promise.withResolvers()
  const releases = []
  const completed = []
  fsp.readFile = async (path, ...rest) => {
    if (!String(path).startsWith(photoFiles)) return readFile(path, ...rest)
    const index = started++
    reading++
    peak = Math.max(peak, reading)
    // Hold the first eight reads so the test can release them in reverse order.
    const gate = index < 8 ? { resume: Promise.withResolvers(), done: Promise.withResolvers() } : undefined
    if (gate) {
      releases.push(gate)
      if (releases.length === 8) firstWave.resolve()
      await gate.resume.promise
    }
    try { return await readFile(path, ...rest) } finally {
      reading--
      completed.push(index)
      gate?.done.resolve()
    }
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.readFile = readFile
    syncBuiltinESMExports()
  })

  const pending = call('avatar-library', { limit: 20 })
  await firstWave.promise
  for (const gate of releases.reverse()) {
    gate.resume.resolve()
    await gate.done.promise
  }
  const page = (await pending).value
  const expected = photos.map(photo => photo.name).filter((_, index) => !gone.has(index)).reverse()
  assert.deepEqual(page.items.map(item => item.name), expected)
  assert.equal(page.items.every(item => item.image === photos[Number(item.name.match(/\d+/)[0])].image), true)
  assert.equal(page.next, 20)
  assert.equal(peak, 8)
  assert.deepEqual(completed.filter(index => index < 8), [7, 6, 5, 4, 3, 2, 1, 0])
})
