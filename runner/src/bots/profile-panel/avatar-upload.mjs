// DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a. Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0.
import { t } from './avatar-i18n.mjs'

export async function avatarImage(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error(t('Choose a PNG, JPEG, WebP, or GIF image'))
  if (file.size > 25 * 1024 * 1024) throw new Error(t('Choose an image smaller than 25 MB'))
  const bitmap = await createImageBitmap(file)
  const side = 160
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const context = canvas.getContext('2d')
  context.imageSmoothingQuality = 'high'
  const crop = Math.min(bitmap.width, bitmap.height)
  context.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, side, side)
  bitmap.close?.()
  for (const quality of [0.9, 0.75, 0.6]) {
    const url = canvas.toDataURL('image/webp', quality)
    if (url.startsWith('data:image/webp') && url.length < 150000) return url
  }
  const png = canvas.toDataURL('image/png')
  if (png.length < 150000) return png
  throw new Error(t('That image is too large'))
}
