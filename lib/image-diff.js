// Pixel comparison for two captured images. Decoding happens on the Host; the result is evidence with an
// explicit tolerance and mask set, and a baseline changes only when the caller asks for it.
import { inflateSync } from 'node:zlib'
const diffFail = (code, message) => Object.assign(new Error(message), { code })
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }
/** Decode the subset of PNG produced by Chromium captures: 8-bit, non-interlaced, RGB/RGBA/gray. */
export function decodePng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33) throw diffFail('IMAGE_INVALID', 'Not a PNG image.')
  const buffer = Buffer.from(bytes)
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw diffFail('IMAGE_INVALID', 'Not a PNG image.')
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (data.length !== length) throw diffFail('IMAGE_INVALID', 'Truncated PNG chunk.')
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !CHANNELS[colorType]) throw diffFail('IMAGE_UNSUPPORTED', 'Only 8-bit non-interlaced PNG captures are compared.')
  if (width * height > 40_000_000) throw diffFail('IMAGE_TOO_LARGE', 'Image exceeds the comparison pixel budget.')
  const channels = CHANNELS[colorType]
  const stride = width * channels
  let raw
  try { raw = inflateSync(Buffer.concat(idat)) } catch { throw diffFail('IMAGE_INVALID', 'Corrupt PNG image data.') }
  if (raw.length < (stride + 1) * height) throw diffFail('IMAGE_INVALID', 'Incomplete PNG data.')
  const pixels = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      switch (filter) {
        case 0: break
        case 1: line[x] = (line[x] + left) & 0xff; break
        case 2: line[x] = (line[x] + up) & 0xff; break
        case 3: line[x] = (line[x] + ((left + up) >> 1)) & 0xff; break
        case 4: { const p = left + up - upLeft; const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft); line[x] = (line[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff; break }
        default: throw diffFail('IMAGE_INVALID', 'Unknown PNG filter.')
      }
    }
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4, source = x * channels
      if (channels === 1 || channels === 2) { pixels[at] = pixels[at + 1] = pixels[at + 2] = line[source]; pixels[at + 3] = channels === 2 ? line[source + 1] : 255 }
      else { pixels[at] = line[source]; pixels[at + 1] = line[source + 1]; pixels[at + 2] = line[source + 2]; pixels[at + 3] = channels === 4 ? line[source + 3] : 255 }
    }
    previous = line
  }
  return { width, height, data: new Uint8Array(pixels) }
}
/** Compare two decoded images; masked regions are excluded and the baseline never changes implicitly. */
export function compareImages(before, after, { tolerance = 0.02, mask = [], channelTolerance = 0 } = {}) {
  if (!before || !after || before.width !== after.width || before.height !== after.height) throw diffFail('DIMENSION_MISMATCH', 'Images must share dimensions.')
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) throw diffFail('INVALID_ARGUMENT', 'tolerance must be 0–1.')
  if (!Number.isSafeInteger(channelTolerance) || channelTolerance < 0 || channelTolerance > 255) throw diffFail('INVALID_ARGUMENT', 'channelTolerance must be 0–255.')
  for (const image of [before, after]) if (!(image.data instanceof Uint8Array) || image.data.length !== image.width * image.height * 4) throw diffFail('IMAGE_INVALID', 'RGBA pixel buffers are required.')
  let differing = 0, compared = 0
  for (let i = 0; i < before.width * before.height; i++) {
    const x = i % before.width, y = Math.floor(i / before.width)
    if (mask.some(rect => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height)) continue
    compared++
    const at = i * 4
    if (Math.abs(before.data[at] - after.data[at]) > channelTolerance || Math.abs(before.data[at + 1] - after.data[at + 1]) > channelTolerance || Math.abs(before.data[at + 2] - after.data[at + 2]) > channelTolerance || Math.abs(before.data[at + 3] - after.data[at + 3]) > channelTolerance) differing++
  }
  const ratio = compared === 0 ? 0 : differing / compared
  return { ratio, differing, comparedPixels: compared, pass: ratio <= tolerance, tolerance, channelTolerance, maskedRegions: mask.length, updateBaseline: false, note: 'Baselines change only on an explicit choice.' }
}
export const IMAGE_DIFF_LIMITS = Object.freeze({ maxPixels: 40_000_000, formats: ['png'], decodedOnHost: true })
