import { randomUUID } from 'node:crypto'

const MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const abort = signal => { if (signal?.aborted) fail('IMAGE_ABORTED', 'Image operation was aborted.') }

/** Session/workspace must be host-generated strings; nothing else is accepted as an owner. */
function binding(context) {
  for (const key of ['sessionId', 'workspace']) {
    const value = context?.[key]
    if (typeof value !== 'string' || !value || value.length > 4096) fail('IMAGE_CONTEXT', 'Image request rejected.')
  }
  return { sessionId: context.sessionId, workspace: context.workspace }
}

function limitsOf(attachments, maxBytes, maxPixels) {
  const host = attachments.imageLimits ?? {}
  const mediaTypes = Array.isArray(host.mediaTypes) ? host.mediaTypes.filter(type => MEDIA_TYPES.includes(type)) : MEDIA_TYPES
  if (mediaTypes.length === 0) fail('IMAGE_LIMITS', 'Host attachment store admits no image media type.')
  const byteCap = [maxBytes, integer(host.maxImageBytes, 1, 2 ** 31) ? host.maxImageBytes : maxBytes].reduce((a, b) => Math.min(a, b))
  const pixelCap = [maxPixels, integer(host.maxImagePixels, 1, 2 ** 31) ? host.maxImagePixels : maxPixels].reduce((a, b) => Math.min(a, b))
  return { maxBytes: byteCap, maxPixels: pixelCap, maxDimension: integer(host.maxImageDimension, 1, 2 ** 31) ? host.maxImageDimension : 65535, mediaTypes }
}

/**
 * Session-scoped image artifact index over the Host attachment service.
 * The plugin stores only metadata; image bytes live in DSH's immutable attachment store.
 */
export class ImageArtifacts {
  #items = new Map()
  #reservations = new Set()
  #closed = false
  constructor({ attachments, maxBytes = 16 * 1024 * 1024, maxPixels = 32e6, maxEntries = 256, maxWorkspaceBytes = 64 * 1024 * 1024, maxTotalBytes = 256 * 1024 * 1024 } = {}) {
    const service = attachments
    if (!service || typeof service !== 'object') fail('IMAGE_SERVICE', 'Attachment service is required.')
    for (const method of ['saveImage', 'validateImage', 'imageHostPath']) if (typeof service[method] !== 'function') fail('IMAGE_SERVICE', 'Attachment service is incomplete.')
    if (!integer(maxBytes, 1, 64 * 1024 * 1024) || !integer(maxPixels, 1, 2 ** 31) || !integer(maxEntries, 1, 10000)) fail('IMAGE_LIMITS', 'Image limits are invalid.')
    if (!integer(maxWorkspaceBytes, 1, 2 ** 31) || !integer(maxTotalBytes, 1, 2 ** 31)) fail('IMAGE_LIMITS', 'Image storage limits are invalid.')
    this.attachments = service
    this.maxEntries = maxEntries
    this.maxWorkspaceBytes = maxWorkspaceBytes
    this.maxTotalBytes = maxTotalBytes
    this.limits = Object.freeze(limitsOf(service, maxBytes, maxPixels))
  }
  #assertOpen() { if (this.#closed) fail('IMAGE_CLOSED', 'Image artifacts are closed.') }
  #owner(context) { this.#assertOpen(); return binding(context) }
  #admit(data, mediaType) {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) fail('IMAGE_ARGUMENT', 'Image bytes are required.')
    if (!this.limits.mediaTypes.includes(mediaType)) fail('IMAGE_MEDIA_TYPE', 'Image media type is not admitted.')
    if (data.byteLength > this.limits.maxBytes) fail('IMAGE_TOO_LARGE', 'Image exceeds the byte limit.')
    return { data, mediaType }
  }
  #reserve(owner, bytes) {
    // Global count and byte quotas include in-flight saves, before allocating a private byte copy.
    let total = bytes, workspace = bytes
    for (const item of this.#items.values()) { total += item.attachment.bytes; if (item.workspace === owner.workspace) workspace += item.attachment.bytes }
    for (const item of this.#reservations) { total += item.bytes; if (item.workspace === owner.workspace) workspace += item.bytes }
    if (this.#items.size + this.#reservations.size >= this.maxEntries || total > this.maxTotalBytes || workspace > this.maxWorkspaceBytes) fail('IMAGE_QUOTA', 'Image artifact quota exceeded.')
    const reservation = { ...owner, bytes }
    this.#reservations.add(reservation)
    return { resize: size => {
      let currentTotal = size, currentWorkspace = size
      for (const item of this.#items.values()) { currentTotal += item.attachment.bytes; if (item.workspace === owner.workspace) currentWorkspace += item.attachment.bytes }
      for (const item of this.#reservations) if (item !== reservation) { currentTotal += item.bytes; if (item.workspace === owner.workspace) currentWorkspace += item.bytes }
      if (currentTotal > this.maxTotalBytes || currentWorkspace > this.maxWorkspaceBytes) fail('IMAGE_QUOTA', 'Normalized image exceeds the reserved quota.')
      reservation.bytes = size
    }, release: () => { this.#reservations.delete(reservation) } }
  }
  #metadata(item) {
    return { artifactId: item.artifactId, attachmentId: item.attachment.attachmentId, mediaType: item.attachment.mediaType, bytes: item.attachment.bytes, width: item.attachment.width, height: item.attachment.height, createdAt: item.createdAt, storage: 'attachment', pixels: item.attachment.width * item.attachment.height }
  }
  /** Save one explicitly authorized screenshot image. The caller owns the screenshot decision; no authority is inferred here. */
  async save(context, { data, mediaType } = {}, signal) {
    const owner = this.#owner(context)
    abort(signal)
    const image = this.#admit(data, mediaType)
    const reservation = this.#reserve(owner, image.data.byteLength)
    let savedByHost = false
    try {
      const data = new Uint8Array(image.data)
      const saved = await this.attachments.saveImage({ data, mediaType: image.mediaType })
      savedByHost = true
      const ref = saved && typeof saved === 'object' ? saved : fail('IMAGE_SERVICE', 'Attachment service returned no reference.')
      if (typeof ref.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(ref.attachmentId) || !MEDIA_TYPES.includes(ref.mediaType) || !integer(ref.bytes, 1, 2 ** 31) || !integer(ref.width, 1, 2 ** 31) || !integer(ref.height, 1, 2 ** 31)) fail('IMAGE_SERVICE', 'Attachment service returned an invalid reference.')
      if (ref.bytes > this.limits.maxBytes || ref.width * ref.height > this.limits.maxPixels || ref.width > this.limits.maxDimension || ref.height > this.limits.maxDimension) fail('IMAGE_TOO_LARGE', 'Image exceeds the byte, pixel or dimension limit.')
      reservation.resize(ref.bytes)
      const attachment = Object.freeze({ attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...(typeof ref.name === 'string' && ref.name ? { name: ref.name.slice(0, 255) } : {}), ...(ref.originalDimensions && integer(ref.originalDimensions.width, 1, 2 ** 31) && integer(ref.originalDimensions.height, 1, 2 ** 31) ? { originalDimensions: Object.freeze({ width: ref.originalDimensions.width, height: ref.originalDimensions.height }) } : {}) })
      const artifactId = randomUUID()
      // Abort after the Host save: nothing is published here, but the DSH attachment may already exist (immutable, no public delete).
      try { abort(signal) } catch (error) {
        error.attachmentPersisted = true
        throw error
      }
      this.#assertOpen()
      const item = { ...owner, artifactId, attachment, createdAt: Date.now() }
      this.#items.set(artifactId, item)
      return this.#metadata(item)
    } catch (error) {
      if (savedByHost && error && typeof error === 'object') error.attachmentPersisted = true
      throw error
    } finally { reservation.release() }
  }
  #get(context, artifactId) {
    const owner = this.#owner(context)
    if (typeof artifactId !== 'string' || !UUID.test(artifactId)) fail('IMAGE_NOT_FOUND', 'Image artifact not found.')
    const item = this.#items.get(artifactId)
    // Uniform not-found avoids confirming another Session's or workspace's artifact.
    if (!item || item.sessionId !== owner.sessionId || item.workspace !== owner.workspace) fail('IMAGE_NOT_FOUND', 'Image artifact not found.')
    return item
  }
  get(context, artifactId) { return this.#metadata(this.#get(context, artifactId)) }
  /** Model-facing blocks: metadata JSON plus the Host image block only when the route admits images. */
  render(context, artifactId, { supportsImages } = {}) {
    const item = this.#get(context, artifactId)
    const { artifactId: id, attachment } = item
    const warnings = ['Image pixels may contain secrets; redaction cannot inspect them.']
    if (supportsImages === true) {
      return [{ type: 'text', text: JSON.stringify({ ...this.#metadata(item), warnings }) }, { type: 'image', attachment }]
    }
    const fallback = typeof this.attachments.imageHostPath === 'function' ? this.attachments.imageHostPath(attachment) : undefined
    const text = { ...this.#metadata(item), warnings: [...warnings, 'Images are not supported on this route; no image was sent.'], ...(typeof fallback === 'string' && fallback ? { hostPath: fallback } : {}) }
    return [{ type: 'text', text: JSON.stringify(text) }]
  }
  deleteBinding(context, artifactId) {
    this.#get(context, artifactId)
    // Only the plugin index entry is removed; the shared DSH attachment is never deleted.
    this.#items.delete(artifactId)
    return { artifactId, deleted: true, attachmentRetained: true }
  }
  close() { this.#items.clear(); this.#closed = true }
}
