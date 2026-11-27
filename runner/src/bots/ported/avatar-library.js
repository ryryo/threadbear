// DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a. Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
// The avatar library: photos the user imported once, kept in the Bot data folder so the
// same picture can be picked for several Bots and outlives the Bot that used it. Every
// image is named by the hash of its bytes, so the same picture is stored once, and the
// index and the images are written whole, so a half-written file is never read.
import { createHash } from 'node:crypto'
import { constants, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { avatarBytes } from './avatar-image.js'
import { MAX_AVATAR_IMAGE } from './roster-copy.js'
import { atomicWriteFileSync } from '../../fsutil.ts'

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const HASH = /^[0-9a-f]{64}$/
const MAX_PHOTOS = 500
// How many photos one answer carries. A window asks for the rest when it wants them,
// so a big library does not become one huge reply.
const MAX_LISTED = 48
// How many photo files one page reads at once: enough to overlap the waits on the
// disk, few enough that a page never holds many files open.
const PARALLEL_READS = 8
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const MAX_INDEX_BYTES = 1024 * 1024
const info = path => lstatSync(path, { throwIfNoEntry: false })
const same = (original, current) => original?.dev === current?.dev && original?.ino === current?.ino

export function install(rt) {
  const home = realpathSync(rt.home)
  const initialHome = info(home)
  const root = join(home, 'avatars')
  const files = join(root, 'files')
  const indexPath = join(root, 'index.json')

  const fileOf = entry => join(files, `${entry.id}.${EXTENSIONS[entry.mime]}`)

  // The primary Runner lock serializes hosts. Recheck the profile lease and
  // local directories after asynchronous reads, just before every mutation.
  const fence = (authorize = () => {}) => {
    const readDirectory = path => {
      const current = info(path)
      if (current && !current.isDirectory()) throw new Error('The avatar library directory changed.')
      return current
    }
    let rootInfo = readDirectory(root)
    let filesInfo = rootInfo && readDirectory(files)
    const check = () => {
      authorize()
      if (!same(initialHome, readDirectory(home)) || !same(rootInfo, readDirectory(root)) ||
          !same(filesInfo, rootInfo && readDirectory(files))) throw new Error('The avatar library directory changed.')
    }
    return { check, prepare: needsFiles => {
      check()
      if (!rootInfo) { mkdirSync(root, { mode: 0o700 }); rootInfo = readDirectory(root) }
      if (needsFiles && !filesInfo) { mkdirSync(files, { mode: 0o700 }); filesInfo = readDirectory(files) }
    } }
  }

  // One write at a time: two imports that overlap would each read the index, and the
  // second write would drop what the first one added.
  let queue = Promise.resolve()
  const serial = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => {}, () => {})
    return run
  }

  // The index on disk, with the entries that can be trusted: an id that is a hash, a
  // known type, and a name that is text.
  const readIndex = async ({ check }) => {
    check()
    const stored = info(indexPath)
    if (!stored || stored.isDirectory()) return []
    if (!stored.isFile() || stored.size > MAX_INDEX_BYTES) throw new Error('The avatar library index is unavailable.')
    const raw = await readFile(indexPath, { flag: flags, encoding: 'utf8' })
    check()
    const parsed = JSON.parse(raw)
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    return items
      .filter(entry => typeof entry?.id === 'string' && HASH.test(entry.id) && Object.hasOwn(EXTENSIONS, entry.mime))
      .map(entry => ({
        id: entry.id,
        name: String(entry.name ?? '').slice(0, 120),
        mime: entry.mime,
        bytes: Number(entry.bytes) || 0,
        createdAt: Number(entry.createdAt) || 0,
      }))
  }

  const writeIndex = (items, guard) => {
    guard.prepare(false)
    const existing = info(indexPath)
    if (existing && !existing.isFile()) throw new Error('The avatar library index is unavailable.')
    atomicWriteFileSync(indexPath, JSON.stringify({ version: 1, items }, null, 2), 0o600)
  }

  const writeImage = (entry, bytes, guard) => {
    guard.prepare(true)
    const path = fileOf(entry)
    const existing = info(path)
    if (existing && !existing.isFile()) throw new Error('The avatar library photo is unavailable.')
    atomicWriteFileSync(path, bytes, 0o600)
  }

  // One photo at a time, so a photo that cannot be read does not lose the others. The
  // picture is checked as an image, and the same bytes are kept once.
  const importPhotos = (items, authorize) => serial(async () => {
    const guard = fence(authorize)
    const index = await readIndex(guard)
    const result = { imported: [], duplicates: [], failed: [] }
    for (const item of items) {
      guard.check()
      const name = String(item?.name ?? '').trim().slice(0, 120)
      try {
        const { bytes, mime } = avatarBytes(item?.image)
        const id = createHash('sha256').update(bytes).digest('hex')
        const known = index.find(entry => entry.id === id)
        if (known) {
          // The same picture again: the one that is there stays, and its file is put
          // back when it went missing.
          if (!info(fileOf(known))?.isFile()) writeImage(known, bytes, guard)
          result.duplicates.push({ id: known.id, name: known.name })
          continue
        }
        if (index.length >= MAX_PHOTOS) throw new Error(`The avatar library holds at most ${MAX_PHOTOS} photos.`)
        const entry = { id, name: name || 'photo', mime, bytes: bytes.length, createdAt: Date.now() }
        writeImage(entry, bytes, guard)
        writeIndex([...index, entry], guard)
        index.push(entry)
        result.imported.push(entry)
      } catch (error) {
        result.failed.push({ name, message: error?.message ?? String(error) })
      }
    }
    return result
  })

  // Each entry's image as a data URL, in the order of the entries; a file that cannot
  // be read is left undefined.
  const readImages = async (entries, guard) => {
    const images = Array.from({ length: entries.length })
    let next = 0
    const reader = async () => {
      while (next < entries.length) {
        const at = next++
        guard.check()
        const entry = entries[at]
        const file = fileOf(entry)
        const before = info(file)
        if (!before?.isFile() || before.size !== entry.bytes || before.size > MAX_AVATAR_IMAGE) continue
        const bytes = await readFile(file, { flag: flags }).catch(() => undefined)
        guard.check()
        if (bytes !== undefined && same(before, info(file)) && createHash('sha256').update(bytes).digest('hex') === entry.id) {
          images[at] = `data:${entry.mime};base64,${bytes.toString('base64')}`
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, entries.length) }, reader))
    return images
  }

  // The photos the user can pick, with the image itself, so the window needs one
  // request to draw the library. The newest come first, and a library with many photos
  // is asked for page by page.
  const libraryView = async ({ offset = 0, limit = MAX_LISTED } = {}, authorize) => {
    const guard = fence(authorize)
    const index = await readIndex(guard)
    const ordered = [...index].reverse().sort((a, b) => b.createdAt - a.createdAt)
    const start = Math.max(0, Math.floor(Number(offset)) || 0)
    const count = Math.min(MAX_LISTED, Math.max(1, Math.floor(Number(limit)) || MAX_LISTED))
    const page = ordered.slice(start, start + count)
    const images = await readImages(page, guard)
    guard.check()
    const items = page.flatMap((entry, at) => images[at] === undefined ? [] : [{ ...entry, image: images[at] }])
    // The next page starts where this one stopped, even when a photo went missing.
    return { items, total: ordered.length, next: start + page.length }
  }

  // A photo leaves the library; the Bots that use it keep their own copy.
  const deletePhoto = (id, authorize) => serial(async () => {
    const guard = fence(authorize)
    const index = await readIndex(guard)
    guard.check()
    const entry = index.find(item => item.id === id)
    if (entry === undefined) return false
    rmSync(fileOf(entry), { force: true })
    writeIndex(index.filter(item => item.id !== id), guard)
    return true
  })

  return Object.assign(rt, { avatarLibraryView: libraryView, avatarLibraryImport: importPhotos, avatarLibraryDelete: deletePhoto })
}
