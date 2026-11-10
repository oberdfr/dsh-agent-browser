// Optional explicit persistence. All paths are generated from Host-resolved workspace roots.
// Fs and KvTable are the public DSH contracts discovered via Cordis Inspect, not page capabilities.
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRedactor } from './redaction.js'

const WEEK = 7 * 24 * 60 * 60 * 1000
const ID = /^artifact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const fail = code => { throw Object.assign(new Error('Artifact persistence request rejected.'), { code }) }
const digest = text => createHash('sha256').update(text).digest('hex')
const sameOwner = (a,b) => a.sessionId === b.sessionId && a.workspace === b.workspace
function owner(context) {
  for (const key of ['sessionId','workspace']) if (typeof context?.[key] !== 'string' || !context[key].trim() || context[key].length > 4096) fail('ARTIFACT_CONTEXT')
  return { sessionId: context.sessionId, workspace: context.workspace }
}
function validateId(id) { if (typeof id !== 'string' || !ID.test(id)) fail('ARTIFACT_ID') }

export class ArtifactPersistence {
  #queue = Promise.resolve()
  #closed = false
  constructor({ fs, table, resolveDirectory, now = Date.now, ttlMs = WEEK, maxItemBytes = 16 * 1024 * 1024, maxWorkspaceBytes = 64 * 1024 * 1024, maxTotalBytes = 256 * 1024 * 1024, maxItems = 4096, redactor } = {}) {
    if (!fs?.resolve || !fs?.writeText || !fs?.readBytes || !fs?.contains || !table?.entries || !table?.get || !table?.put || !table?.delete || typeof resolveDirectory !== 'function') fail('ARTIFACT_STORAGE_UNAVAILABLE')
    for (const n of [ttlMs,maxItemBytes,maxWorkspaceBytes,maxTotalBytes,maxItems]) if (!Number.isSafeInteger(n) || n < 1) fail('ARTIFACT_ARGUMENT')
    Object.assign(this, { fs, table, resolveDirectory, now, ttlMs, maxItemBytes, maxWorkspaceBytes, maxTotalBytes, maxItems })
    this.redact = redactor ?? createRedactor({ maxStringChars: maxItemBytes })
  }
  #serialize(operation, signal) {
    const result = this.#queue.catch(() => {}).then(async () => {
      if (this.#closed) fail('ARTIFACT_STORAGE_CLOSED')
      signal?.throwIfAborted()
      return operation()
    })
    this.#queue = result
    return result
  }
  #normalize(context, snapshot) {
    const binding = owner(context)
    validateId(snapshot?.id)
    if (!['application/json', 'text/plain'].includes(snapshot.mediaType) || typeof snapshot.text !== 'string' || !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0 || snapshot.createdAt > this.now() || typeof snapshot.pinned !== 'boolean') fail('ARTIFACT_RECORD')
    if (snapshot.text.length > this.maxItemBytes) fail('ARTIFACT_ITEM_LIMIT')
    let value
    try { value = snapshot.mediaType === 'application/json' ? JSON.parse(snapshot.text) : snapshot.text } catch { fail('ARTIFACT_RECORD') }
    const clean = this.redact(value)
    const text = snapshot.mediaType === 'application/json' ? JSON.stringify(clean) : clean
    const bytes = Buffer.byteLength(text)
    if (bytes > this.maxItemBytes) fail('ARTIFACT_ITEM_LIMIT')
    return { ...binding, id: snapshot.id, mediaType: snapshot.mediaType, createdAt: snapshot.createdAt, pinned: snapshot.pinned, bytes, sha256: digest(text), text }
  }
  async #durable(operation) {
    try { return await operation() }
    catch (error) {
      if (error?.code === 'unknown-state') {
        this.#closed = true
        throw Object.assign(new Error('Artifact storage outcome is unknown; close and reopen the DSH domain before further operations.'), { code: 'ARTIFACT_STORAGE_UNKNOWN_STATE', requiresReopen: true })
      }
      throw error
    }
  }
  #lookup(context, id) {
    const binding = owner(context)
    validateId(id)
    const record = this.table.get(id)
    if (!record || !sameOwner(binding, record)) fail('ARTIFACT_NOT_FOUND')
    return record
  }
  #quota(candidate) {
    let total = 0, workspace = 0, count = 0
    for (const [id, record] of this.table.entries()) {
      if (id === candidate.id) continue
      if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) fail('ARTIFACT_INDEX_CORRUPT')
      count++; total += record.bytes
      if (record.workspace === candidate.workspace) workspace += record.bytes
    }
    if (count + 1 > this.maxItems || total + candidate.bytes > this.maxTotalBytes || workspace + candidate.bytes > this.maxWorkspaceBytes) fail('ARTIFACT_QUOTA')
  }
  async #target(context, id, signal) {
    validateId(id)
    const directory = await this.resolveDirectory(owner(context), signal)
    signal?.throwIfAborted()
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('ARTIFACT_ROOT')
    const root = await this.fs.resolve(directory, { signal })
    const info = await this.fs.stat(root, signal)
    if (info?.type !== 'directory') fail('ARTIFACT_ROOT')
    const parts = [path.join(directory, '.browser-dsh'), path.join(directory, '.browser-dsh', 'artifacts'), path.join(directory, '.browser-dsh', 'artifacts', `${id}.json`)]
    for (const filename of parts) {
      const link = await this.fs.lstat(filename, undefined, signal)
      if (link?.type === 'symlink' || link?.type === 'other') fail('ARTIFACT_PATH_UNSAFE')
      const child = await this.fs.resolve(filename, { signal })
      if (!this.fs.contains(root, child)) fail('ARTIFACT_PATH_UNSAFE')
    }
    const target = await this.fs.resolve(parts.at(-1), { signal })
    return { root, target, directory, policy: { mode: 'workspace-write', workspaceRoot: directory, sessionId: context.sessionId } }
  }
  #metadata(record) { return { artifactId: record.id, mediaType: record.mediaType, bytes: record.bytes, createdAt: record.createdAt, pinned: record.pinned, saved: true, storage: record.storage, redacted: true } }
  save(context, snapshot, signal) {
    // Normalize and bind before entering the asynchronous queue: caller mutation cannot retarget it.
    const candidate = this.#normalize(context, snapshot)
    return this.#serialize(async () => {
      this.#quota(candidate)
      const existing = this.table.get(candidate.id)
      if (existing) {
        if (!sameOwner(existing, candidate) || existing.sha256 !== candidate.sha256 || existing.mediaType !== candidate.mediaType) fail('ARTIFACT_CONFLICT')
        return this.#metadata(existing)
      }
      let location, version
      let workspaceWritten = false
      try {
        location = await this.#target(candidate, candidate.id, signal)
        signal?.throwIfAborted()
        const outcome = await this.fs.writeText(location.target, candidate.text, { kind: 'createIfAbsent' }, signal, location.policy)
        version = outcome.version
        workspaceWritten = true
      } catch (error) {
        signal?.throwIfAborted()
        // Integrity/symlink/conflict errors never silently become success in another location.
        const fallbackCodes = ['EACCES','EPERM','EROFS','ENOENT','FS_PERMISSION_DENIED','FS_ACCESS_DENIED','FS_NOT_FOUND','FS_READ_ONLY']
        if (!fallbackCodes.includes(error?.code)) throw error
      }
      // Once a workspace file is published, finish its index commit even if cancellation raced it.
      const record = workspaceWritten ? { ...candidate, text: null, storage: 'workspace', rootKey: location.root.targetKey } : { ...candidate, storage: 'plugin-storage' }
      try { await this.#durable(() => this.table.put(candidate.id, record)) }
      catch (error) {
        // A backend may already have committed: never delete a file on an unknown index outcome.
        if (error?.code === 'ARTIFACT_STORAGE_UNKNOWN_STATE') throw error
        // Only remove the exact version published by this operation, using a previously validated target.
        if (workspaceWritten) {
          try { await this.fs.deleteFile(location.target, { version }, undefined, location.policy) }
          catch { fail('ARTIFACT_PARTIAL_SAVE') }
        }
        throw error
      }
      if (signal?.aborted) throw Object.assign(new Error('Artifact save was cancelled after publication; the saved artifact remains addressable by ID.'), { code: 'ARTIFACT_ABORTED', artifactPersisted: true })
      return this.#metadata(record)
    }, signal)
  }
  load(context, id, signal) {
    const binding = owner(context)
    validateId(id)
    return this.#serialize(async () => {
      const record = this.#lookup(binding, id)
      if (!record.pinned && this.now() - record.createdAt >= this.ttlMs) fail('ARTIFACT_EXPIRED')
      let text
      if (record.storage === 'plugin-storage') text = record.text
      else if (record.storage === 'workspace') {
        const { target, root } = await this.#target(binding, id, signal)
        if (root.targetKey !== record.rootKey) fail('ARTIFACT_ROOT_CHANGED')
        const stat = await this.fs.stat(target, signal)
        if (stat?.type !== 'file' || !Number.isSafeInteger(stat.size) || stat.size > this.maxItemBytes) fail('ARTIFACT_FILE_INVALID')
        text = new TextDecoder('utf-8', { fatal: true }).decode(await this.fs.readBytes(target, signal, this.maxItemBytes))
      } else fail('ARTIFACT_INDEX_CORRUPT')
      if (typeof text !== 'string' || Buffer.byteLength(text) !== record.bytes || digest(text) !== record.sha256) fail('ARTIFACT_INTEGRITY')
      signal?.throwIfAborted()
      const normalized = this.#normalize(binding, { ...record, text })
      return { id, text: normalized.text, mediaType: normalized.mediaType, createdAt: normalized.createdAt, pinned: normalized.pinned }
    }, signal)
  }
  pin(context, id, pinned, signal) {
    const binding = owner(context)
    if (typeof pinned !== 'boolean') fail('ARTIFACT_ARGUMENT')
    return this.#serialize(async () => { const record = this.#lookup(binding, id); await this.#durable(() => this.table.put(id, { ...record, pinned })); return this.#metadata({ ...record, pinned }) }, signal)
  }
  async #remove(context, id, signal) {
    const record = this.#lookup(context, id)
    if (record.storage === 'workspace') {
      const { target, policy, root } = await this.#target(context, id, signal)
      if (root.targetKey !== record.rootKey) fail('ARTIFACT_ROOT_CHANGED')
      const stat = await this.fs.stat(target, signal)
      if (stat) {
        if (stat.type !== 'file' || stat.size > this.maxItemBytes) fail('ARTIFACT_FILE_INVALID')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await this.fs.readBytes(target, signal, this.maxItemBytes))
        if (Buffer.byteLength(text) !== record.bytes || digest(text) !== record.sha256) fail('ARTIFACT_INTEGRITY')
        // Canonical target and exact version are verified before deletion; no page path is accepted.
        await this.fs.deleteFile(target, { version: stat.version }, signal, policy)
      }
    } else if (record.storage !== 'plugin-storage') fail('ARTIFACT_INDEX_CORRUPT')
    await this.#durable(() => this.table.delete(id))
    return { artifactId: id, deleted: true }
  }
  delete(context, id, signal) { const binding = owner(context); validateId(id); return this.#serialize(() => this.#remove(binding, id, signal), signal) }
  cleanup(signal) {
    return this.#serialize(async () => {
      let deleted = 0, retained = 0
      for (const [id, record] of [...this.table.entries()]) {
        signal?.throwIfAborted()
        if (record.pinned || this.now() - record.createdAt < this.ttlMs) continue
        try { await this.#remove(owner(record), id, signal); deleted++ } catch (error) { signal?.throwIfAborted(); if (this.#closed) throw error; retained++ }
      }
      return { deleted, retained, warnings: retained ? ['Some expired workspace artifacts could not be safely removed; no arbitrary paths were deleted.'] : [] }
    }, signal)
  }
  async close() { this.#closed = true; await this.#queue.catch(() => {}) }
}
