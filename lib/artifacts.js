import { randomUUID } from 'node:crypto'
import { createRedactor } from './redaction.js'

const WEEK = 7 * 24 * 60 * 60 * 1000
const idPattern = /^artifact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const fail = code => { throw Object.assign(new Error('Artifact request rejected.'), { code }) }
function binding(context) {
  for (const key of ['sessionId', 'workspace']) if (typeof context?.[key] !== 'string' || !context[key] || context[key].length > 4096) fail('ARTIFACT_CONTEXT')
  return { sessionId: context.sessionId, workspace: context.workspace }
}
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('ARTIFACT_ARGUMENT'); return value }

/** Bounded, Session-scoped memory artifacts. Disk persistence is deliberately not implemented here. */
export class ArtifactStore {
  #items = new Map()
  constructor({ now = Date.now, ttlMs = WEEK, maxItemBytes = 16 * 1024 * 1024, maxWorkspaceBytes = 64 * 1024 * 1024, maxTotalBytes = 256 * 1024 * 1024, maxItems = 4096, redactor } = {}) {
    this.now = now
    this.ttlMs = integer(ttlMs, 1, Number.MAX_SAFE_INTEGER)
    this.maxItemBytes = integer(maxItemBytes, 1, 64 * 1024 * 1024)
    this.maxWorkspaceBytes = integer(maxWorkspaceBytes, 1, 1024 * 1024 * 1024)
    this.maxTotalBytes = integer(maxTotalBytes, 1, 4 * 1024 * 1024 * 1024)
    this.maxItems = integer(maxItems, 1, 100000)
    this.redact = redactor ?? createRedactor({ maxStringChars: maxItemBytes })
  }
  cleanup() {
    let deleted = 0
    for (const [id, item] of this.#items) if (!item.pinned && this.now() - item.createdAt >= this.ttlMs) { this.#items.delete(id); deleted++ }
    return { deleted }
  }
  #get(context, artifactId) {
    const owner = binding(context)
    if (typeof artifactId !== 'string' || !idPattern.test(artifactId)) fail('ARTIFACT_ID')
    this.cleanup()
    const item = this.#items.get(artifactId)
    // Uniform error avoids confirming another Session's artifact existence.
    if (!item || item.sessionId !== owner.sessionId || item.workspace !== owner.workspace) fail('ARTIFACT_NOT_FOUND')
    return item
  }
  #metadata(item) {
    return { artifactId: item.id, mediaType: item.mediaType, bytes: item.bytes, createdAt: item.createdAt, pinned: item.pinned, storage: 'memory', redacted: true }
  }
  create(context, value, { format = 'json' } = {}) {
    const owner = binding(context)
    if (!['json', 'text'].includes(format)) fail('ARTIFACT_FORMAT')
    if (format === 'text' && typeof value !== 'string') fail('ARTIFACT_FORMAT')
    this.cleanup()
    const clean = this.redact(value)
    const text = format === 'text' ? clean : JSON.stringify(clean)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.maxItemBytes) fail('ARTIFACT_ITEM_LIMIT')
    let workspaceBytes = 0, totalBytes = 0
    for (const item of this.#items.values()) { totalBytes += item.bytes; if (item.workspace === owner.workspace) workspaceBytes += item.bytes }
    if (this.#items.size >= this.maxItems || totalBytes + bytes > this.maxTotalBytes || workspaceBytes + bytes > this.maxWorkspaceBytes) fail('ARTIFACT_QUOTA')
    const item = { ...owner, id: `artifact-${randomUUID()}`, text, bytes, mediaType: format === 'json' ? 'application/json' : 'text/plain', createdAt: this.now(), pinned: false }
    this.#items.set(item.id, item)
    return this.#metadata(item)
  }
  read(context, artifactId, { offset = 0, maxBytes = 8192 } = {}) {
    const item = this.#get(context, artifactId)
    integer(offset, 0, item.text.length)
    integer(maxBytes, 256, 65536)
    // Offset/cursor are UTF-16 character positions; do not split surrogate pairs at either end.
    if (offset > 0 && /[\uDC00-\uDFFF]/.test(item.text[offset] ?? '')) fail('ARTIFACT_RANGE')
    let end = Math.min(item.text.length, offset + maxBytes)
    if (end < item.text.length && /[\uDC00-\uDFFF]/.test(item.text[end] ?? '')) end--
    while (Buffer.byteLength(item.text.slice(offset, end), 'utf8') > maxBytes) {
      end--
      if (/[\uDC00-\uDFFF]/.test(item.text[end] ?? '')) end--
    }
    return { ...this.#metadata(item), offset, text: item.text.slice(offset, end), nextOffset: end < item.text.length ? end : null, totalChars: item.text.length }
  }
  search(context, artifactId, { query, offset = 0, limit = 20 } = {}) {
    const item = this.#get(context, artifactId)
    if (typeof query !== 'string' || !query || query.length > 512) fail('ARTIFACT_ARGUMENT')
    integer(offset, 0, item.text.length)
    integer(limit, 1, 50)
    const matches = []
    let cursor = offset
    while (matches.length < limit) {
      const at = item.text.indexOf(query, cursor)
      if (at === -1) return { artifactId, matches, nextOffset: null }
      matches.push({ offset: at, preview: item.text.slice(Math.max(0, at - 50), at + query.length + 50) })
      cursor = at + query.length
    }
    return { artifactId, matches, nextOffset: cursor < item.text.length ? cursor : null }
  }
  json(context, artifactId, pointer = '') {
    const item = this.#get(context, artifactId)
    if (item.mediaType !== 'application/json' || typeof pointer !== 'string' || pointer.length > 4096 || (pointer && !pointer.startsWith('/'))) fail('ARTIFACT_JSON_POINTER')
    let value = JSON.parse(item.text)
    for (const segment of pointer ? pointer.slice(1).split('/') : []) {
      if (/~(?:[^01]|$)/.test(segment)) fail('ARTIFACT_JSON_POINTER')
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~')
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) fail('ARTIFACT_JSON_NOT_FOUND')
      value = value[key]
    }
    if (Buffer.byteLength(JSON.stringify(value)) > 65536) fail('ARTIFACT_RESULT_LIMIT')
    return { artifactId, pointer, value }
  }
  list(context, { offset = 0, limit = 20 } = {}) {
    const owner = binding(context)
    integer(offset, 0, Number.MAX_SAFE_INTEGER); integer(limit, 1, 50)
    this.cleanup()
    const items = [...this.#items.values()].filter(item => item.sessionId === owner.sessionId && item.workspace === owner.workspace)
    return { items: items.slice(offset, offset + limit).map(item => this.#metadata(item)), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null }
  }
  pin(context, artifactId, pinned) {
    if (typeof pinned !== 'boolean') fail('ARTIFACT_ARGUMENT')
    const item = this.#get(context, artifactId)
    item.pinned = pinned
    return this.#metadata(item)
  }
  delete(context, artifactId) { this.#get(context, artifactId); this.#items.delete(artifactId); return { artifactId, deleted: true } }
  snapshot(context, artifactId) {
    const item = this.#get(context, artifactId)
    return Object.freeze({ id: item.id, text: item.text, mediaType: item.mediaType, createdAt: item.createdAt, pinned: item.pinned })
  }
  restore(context, snapshot) {
    const owner = binding(context)
    if (!snapshot || typeof snapshot.id !== 'string' || !idPattern.test(snapshot.id) || !['application/json','text/plain'].includes(snapshot.mediaType) || typeof snapshot.text !== 'string' || !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0 || snapshot.createdAt > this.now() || typeof snapshot.pinned !== 'boolean') fail('ARTIFACT_RECORD')
    if (snapshot.text.length > this.maxItemBytes) fail('ARTIFACT_ITEM_LIMIT')
    let value
    try { value = snapshot.mediaType === 'application/json' ? JSON.parse(snapshot.text) : snapshot.text } catch { fail('ARTIFACT_RECORD') }
    const clean = this.redact(value)
    const text = snapshot.mediaType === 'application/json' ? JSON.stringify(clean) : clean
    const bytes = Buffer.byteLength(text)
    if (bytes > this.maxItemBytes) fail('ARTIFACT_ITEM_LIMIT')
    if (!snapshot.pinned && this.now() - snapshot.createdAt >= this.ttlMs) fail('ARTIFACT_EXPIRED')
    this.cleanup()
    const existing = this.#items.get(snapshot.id)
    if (existing) {
      if (existing.sessionId !== owner.sessionId || existing.workspace !== owner.workspace || existing.text !== text || existing.mediaType !== snapshot.mediaType) fail('ARTIFACT_CONFLICT')
      return this.#metadata(existing)
    }
    let workspaceBytes = 0, totalBytes = 0
    for (const item of this.#items.values()) { totalBytes += item.bytes; if (item.workspace === owner.workspace) workspaceBytes += item.bytes }
    if (this.#items.size >= this.maxItems || totalBytes + bytes > this.maxTotalBytes || workspaceBytes + bytes > this.maxWorkspaceBytes) fail('ARTIFACT_QUOTA')
    const item = { ...owner, id: snapshot.id, mediaType: snapshot.mediaType, createdAt: snapshot.createdAt, pinned: snapshot.pinned, text, bytes }
    this.#items.set(item.id, item)
    return this.#metadata(item)
  }
  close() { this.#items.clear() }
}

/** Budgeted model-facing envelope. Raw value and large bodies never appear automatically. */
export function formatResult({ context, value, store, op, tabId, documentId, actionId, coverage = { observed: [], inferred: [], gaps: [] }, maxBytes = 8192, now = Date.now }) {
  integer(maxBytes, 1024, 65536)
  const clean = store.redact(value)
  const result = { op, ...(tabId ? { tabId } : {}), ...(documentId ? { documentId } : {}), ...(actionId ? { actionId } : {}), time: new Date(now()).toISOString(), coverage: store.redact(coverage), data: clean }
  let encoded = JSON.stringify(result)
  if (Buffer.byteLength(encoded) <= maxBytes) return result
  const artifact = store.create(context, clean)
  result.data = { artifactId: artifact.artifactId, bytes: artifact.bytes, preview: JSON.stringify(clean).slice(0, Math.min(512, maxBytes / 4)) }
  result.warnings = ['Output moved to a redacted memory artifact; read by ID/range/search/JSON pointer.']
  encoded = JSON.stringify(result)
  if (Buffer.byteLength(encoded) > maxBytes) {
    result.coverage = { gaps: ['Coverage metadata exceeded the result budget; full metadata is stored in an artifact.'] }
    result.metadataArtifact = store.create(context, { coverage, op, tabId, documentId, actionId })
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('RESULT_METADATA_LIMIT')
  return result
}
