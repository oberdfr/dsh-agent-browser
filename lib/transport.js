// Exact DSH Fetch routes, consumed by Client connection.rpc.call('/api', endpoint, payload, signal).
// Authentication is exclusively DSH Connection's admission; this module never reads cookies or secrets.
export const ENDPOINTS = Object.freeze(['register', 'poll', 'result', 'deregister'])
const MAX_BODY = 1024 * 1024
const MAX_SMALL_BODY = 16 * 1024
const own = (o, k) => Object.hasOwn(o, k)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function failure(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}
function exact(value, allowed, required = allowed) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !own(value, key))) throw failure('INVALID_ARGUMENT', 'Unexpected or missing argument fields.')
}
function text(value, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw failure('INVALID_ARGUMENT', 'Expected a bounded nonempty string.')
  return value
}
function validateJson(value) {
  const stack = [[value, 0]]
  let count = 0
  while (stack.length) {
    const [item, depth] = stack.pop()
    if (++count > 40000 || depth > 32) throw failure('RESULT_LIMIT', 'JSON structure exceeds transport limits.', 413)
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw failure('INVALID_ARGUMENT', 'Unsafe object key.')
        stack.push([child, depth + 1])
      }
    }
  }
}
export async function readEnvelope(request, endpoint, limit) {
  if (request.method !== 'POST') throw failure('METHOD_NOT_ALLOWED', 'POST required.', 405)
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw failure('CONTENT_TYPE', 'application/json required.', 415)
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw failure('BODY_LIMIT', 'Request body exceeds transport limits.', 413)
  const reader = request.body?.getReader()
  if (!reader) throw failure('INVALID_ENVELOPE', 'A JSON request body is required.')
  const chunks = []
  let bytes = 0
  const onAbort = () => { void reader.cancel().catch(() => {}) }
  request.signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      request.signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > limit) throw failure('BODY_LIMIT', 'Request body exceeds transport limits.', 413)
      chunks.push(part.value)
    }
    request.signal.throwIfAborted()
  } catch (error) {
    try { await reader.cancel() } catch {}
    throw error
  } finally {
    request.signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  const buffer = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
  let envelope
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) }
  catch { throw failure('INVALID_ENVELOPE', 'Invalid UTF-8 JSON request.') }
  exact(envelope, ['type', 'rpcId', 'method', 'payload'])
  if (envelope.type !== 'client-request' || envelope.method !== endpoint) throw failure('INVALID_ENVELOPE', 'Invalid Connection RPC envelope.')
  text(envelope.rpcId, 128)
  validateJson(envelope.payload)
  return envelope
}
function payloadFor(operation, payload) {
  const binding = ['sessionId', 'workspace', 'token', 'generation']
  if (operation === 'register') {
    exact(payload, ['sessionId', 'workspace', 'windowId', 'controllerId', 'connectionGeneration'])
    for (const key of Object.keys(payload)) text(payload[key])
  } else {
    const optional = operation === 'poll' ? ['timeoutMs'] : operation === 'result' ? ['results'] : []
    exact(payload, [...binding, ...optional], operation === 'result' ? [...binding, 'results'] : binding)
    for (const key of binding) text(payload[key])
    if (operation === 'poll' && payload.timeoutMs !== undefined && (!Number.isInteger(payload.timeoutMs) || payload.timeoutMs < 0 || payload.timeoutMs > 15000)) throw failure('INVALID_ARGUMENT', 'timeoutMs must be an integer from 0 to 15000.')
    if (operation === 'result') {
      if (!Array.isArray(payload.results) || payload.results.length > 16) throw failure('INVALID_ARGUMENT', 'Provide at most 16 results.')
      for (const result of payload.results) {
        exact(result, ['id', 'ok', 'value', 'error'], ['id', 'ok'])
        text(result.id, 128)
        if (typeof result.ok !== 'boolean' || (result.ok ? !own(result, 'value') || own(result, 'error') : !own(result, 'error') || own(result, 'value'))) throw failure('INVALID_ARGUMENT', 'Each result requires ok and exactly value or error.')
        if (!result.ok) text(result.error, 4000)
      }
    }
  }
  return payload
}
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })

/**
 * One Peer object per authenticated caller, so registry identity checks see the same authority each time.
 * The admitted Peer object itself is reused: copying it would break both identity and the exact-object
 * guarantee the transport tests assert.
 */
function createPeerCache() {
  const peers = new WeakMap()
  return peer => {
    if (!peer || typeof peer !== 'object') return peer
    const existing = peers.get(peer)
    if (existing) return existing
    peers.set(peer, peer)
    return peer
  }
}
/** resolveSession is Host-owned: it must look up a live Session and its authoritative workspace. */
export function createBrowserTransport({ connection, registry, resolveSession }) {
  const stablePeer = createPeerCache()
  if (!connection?.fetch?.register || !connection.admit || !registry || typeof resolveSession !== 'function') throw failure('TRANSPORT_UNAVAILABLE', 'Required DSH transport services are unavailable.', 503)
  const route = operation => ({
    path: `/api/browser-use/${operation}`,
    methods: ['POST'],
    // Own the body limit rather than accepting Connection's much larger aggregate buffer.
    requestBody: 'streaming',
    async fetch(request) {
      let admission
      try { admission = connection.admit(request) }
      catch { return jsonResponse({ error: { code: 'AUTH_UNAVAILABLE', message: 'DSH authentication is unavailable.' } }, 503) }
      if (!admission || admission.rejection !== undefined) return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'DSH transport authorization rejected this request.' } }, admission?.rejection === 403 ? 403 : 401)
      const peer = admission.peer
      if (!peer || peer.principal?.kind !== 'owner' || peer.signal?.aborted) return jsonResponse({ error: { code: 'FORBIDDEN', message: 'An authenticated live owner Peer is required.' } }, 403)
      let envelope
      try {
        request.signal.throwIfAborted()
        envelope = await readEnvelope(request, `browser-use/${operation}`, operation === 'result' ? MAX_BODY : MAX_SMALL_BODY)
        const payload = payloadFor(operation, envelope.payload)
        const context = await resolveSession(payload.sessionId, request.signal)
        request.signal.throwIfAborted()
        if (!context || context.sessionId !== payload.sessionId || context.workspace !== payload.workspace) throw failure('SESSION_WORKSPACE_MISMATCH', 'Session/workspace binding is invalid.', 403)
        // The registry keys registrations by Peer object identity, so the Host must present one stable Peer
        // per authenticated caller. A fresh object per request made every poll/deregister look unregistered.
        const input = { ...payload, peer: stablePeer(peer), signal: request.signal }
        const value = operation === 'register' ? registry.register(input)
          : operation === 'poll' ? await registry.poll(input)
          : operation === 'result' ? registry.submit(input)
          : registry.deregister(input)
        return jsonResponse({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } })
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason ?? error
        // Do not echo client/site data, opaque tokens, peer ids or arbitrary exceptions.
        const known = typeof error?.code === 'string' && /^[A-Z_]{2,64}$/.test(error.code)
        const code = known ? error.code : 'INTERNAL_ERROR'
        const message = known ? 'Browser transport request rejected. Check arguments, Session and controller generation.' : 'Browser transport failed.'
        if (!envelope) return jsonResponse({ error: { code, message } }, Number.isInteger(error?.status) ? error.status : 400)
        return jsonResponse({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code, message, details: {} } } })
      }
    }
  })
  return {
    routes: ENDPOINTS.map(route),
    async install() {
      const disposers = []
      try {
        for (const entry of this.routes) disposers.push(connection.fetch.register(entry))
      } catch (error) {
        for (const dispose of disposers.reverse()) await dispose()
        throw error
      }
      let closed = false
      return async () => {
        if (closed) return
        closed = true
        registry.close()
        for (const dispose of disposers.reverse()) await dispose()
      }
    }
  }
}

export function createSessionResolver({ sessions, workspaceRegistry, workingDirectory }) {
  return async (sessionId, signal) => {
    signal?.throwIfAborted()
    text(sessionId)
    const session = sessions.get(sessionId)
    if (!session || session.id !== sessionId) throw failure('SESSION_NOT_LIVE', 'Session must be retained by DSH.', 403)
    const memberships = workspaceRegistry.list().filter(workspace => workspace.sessionIds.includes(sessionId))
    if (memberships.length > 1) throw failure('AMBIGUOUS_WORKSPACE', 'Session workspace is ambiguous.', 409)
    return {
      sessionId,
      workspace: memberships.length ? `cwd:${memberships[0].path}` : `session:${sessionId}`,
      directory: workingDirectory.get(session)
    }
  }
}
