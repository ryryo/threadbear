// DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a, src/host/avatar.js.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
// The editor accepts a data URL from the user's file chooser.
import { MAX_AVATAR_IMAGE } from './roster-copy.js'

// Base64 is four characters for every three bytes, and the data URL adds a mime
// prefix, so a raw image must stay under this to fit MAX_AVATAR_IMAGE once stored.
const LONGEST_PREFIX = 'data:image/jpeg;base64,'
const MAX_BYTES = Math.floor((MAX_AVATAR_IMAGE - LONGEST_PREFIX.length) / 4) * 3
const HINT = 'Use a square image; 256x256 is recommended.'
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const ascii = (bytes, start, end) => Buffer.from(bytes.subarray(start, end)).toString('latin1')

// The real format, from the bytes themselves: an extension, a Content-Type header, or
// the mime in a data URL can all be wrong.
function mimeOf(bytes) {
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'image/gif'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

const tooLarge = size => `The avatar image is too large: ${size} bytes, and the limit is ${MAX_BYTES} bytes (about 120 KB). ${HINT}`
const NOT_IMAGE = `The avatar must be a PNG, JPEG, WebP, or GIF image. ${HINT}`

function toDataUrl(bytes) {
  if (bytes.length > MAX_BYTES) throw new Error(tooLarge(bytes.length))
  const mime = mimeOf(bytes)
  if (mime === undefined) throw new Error(NOT_IMAGE)
  const url = `data:${mime};base64,${bytes.toString('base64')}`
  if (url.length > MAX_AVATAR_IMAGE) throw new Error(tooLarge(bytes.length))
  return url
}

function readDataUrl(value) {
  const comma = value.indexOf(',')
  if (comma === -1) throw new Error(`The avatar data URL has no comma before its image data. ${HINT}`)
  const header = value.slice('data:'.length, comma)
  const [mime = '', ...params] = header.split(';').map(part => part.trim().toLowerCase())
  if (!MIMES.has(mime)) throw new Error(`The avatar data URL must hold a PNG, JPEG, WebP, or GIF image. ${HINT}`)
  if (!params.includes('base64')) throw new Error('The avatar data URL must be base64 encoded, as in data:image/png;base64,...')
  const payload = value.slice(comma + 1).replace(/\s/g, '')
  if (payload === '' || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error('The avatar data URL does not hold valid base64 image data.')
  }
  const bytes = Buffer.from(payload, 'base64')
  return { url: toDataUrl(bytes), bytes, mime: mimeOf(bytes) }
}

// The image behind an avatar data URL: the bytes, the type they really are, and the
// canonical data URL. The same checks as for a Bot's own avatar apply.
export function avatarBytes(value) {
  return readDataUrl(String(value ?? ''))
}
