// API client and controlled simulations. Page mode runs in the guest; Host mode is explicit, allowlisted and
// never reuses page cookies or claims to be a UI request. Mutating requests are never retried automatically.
const apiFail = (code, message) => Object.assign(new Error(message), { code })
const RECORD = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
export const API_LIMITS = Object.freeze({ requestBytes: 256 * 1024, responseBytes: 1024 * 1024, headers: 50, redirects: 3, delayMs: 30000, mocks: 20 })
const BLOCKED_HOSTNAMES = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i
const isLoopback = hostname => BLOCKED_HOSTNAMES.test(hostname) || hostname === '::1'
/** Page-context request: same session cookies, CORS/CSP still apply. Never sends a Host credential. */
export function pageRequestScript({ method = 'GET', url, headers = {}, body } = {}) {
  if (typeof url !== 'string' || !url.trim() || url.length > 4096) throw apiFail('INVALID_ARGUMENT', 'url is required.')
  const verb = String(method).toUpperCase()
  if (!METHODS.includes(verb)) throw apiFail('INVALID_ARGUMENT', `method must be one of ${METHODS.join(', ')}.`)
  if (!RECORD(headers) || Object.keys(headers).length > API_LIMITS.headers) throw apiFail('INVALID_ARGUMENT', `headers must be an object of at most ${API_LIMITS.headers} entries.`)
  for (const key of Object.keys(headers)) if (/^(?:host|content-length|connection|cookie)$/i.test(key)) throw apiFail('INVALID_ARGUMENT', `Header ${key} cannot be set from the page client.`)
  if (body !== undefined && typeof body !== 'string') throw apiFail('INVALID_ARGUMENT', 'body must be a string.')
  if (body && Buffer.byteLength(body) > API_LIMITS.requestBytes) throw apiFail('REQUEST_TOO_LARGE', 'Request body exceeds the bound.')
  return `(async () => { const started = performance.now(); const response = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(verb)}, headers: ${JSON.stringify(headers)}, credentials: 'same-origin', ${body !== undefined ? `body: ${JSON.stringify(body)}, ` : ''}redirect: 'follow' });
    const text = await response.text(); const clipped = text.length > ${API_LIMITS.responseBytes} ? text.slice(0, ${API_LIMITS.responseBytes}) + '[TRUNCATED]' : text;
    const headersOut = {}; response.headers.forEach((value, key) => { headersOut[key] = key === 'set-cookie' ? '[REDACTED]' : value; });
    return { mode: 'page', status: response.status, ok: response.ok, redirected: response.redirected, url: response.url, headers: headersOut, body: clipped, truncated: text.length > ${API_LIMITS.responseBytes}, durationMs: Math.round(performance.now() - started), note: 'Executed by the page: same cookies, subject to CORS/CSP.' }; })()`
}
/** Host-mode request: explicit origins only, separate credentials, no page cookies, validated redirects. */
export function createHostApiClient({ fetchImpl = globalThis.fetch, allowedOrigins = [], credentials = {}, maxRedirects = API_LIMITS.redirects } = {}) {
  if (typeof fetchImpl !== 'function') throw apiFail('CONFIGURATION', 'A fetch implementation is required.')
  const allowed = new Set(allowedOrigins.filter(origin => typeof origin === 'string').map(origin => { try { return new URL(origin).origin } catch { return null } }).filter(Boolean))
  const allowedList = [...allowed]
  const assertDestination = url => {
    let parsed
    try { parsed = new URL(url) } catch { throw apiFail('INVALID_DESTINATION', 'Invalid URL.') }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw apiFail('INVALID_DESTINATION', 'Only HTTP(S) destinations are allowed.')
    if (isLoopback(parsed.hostname)) throw apiFail('INVALID_DESTINATION', 'DSH and other local services are never valid Host-mode destinations.')
    if (!allowed.has(parsed.origin)) throw apiFail('ORIGIN_NOT_ALLOWED', 'Origin is not explicitly authorized for Host mode.')
    return parsed
  }
  return async function hostRequest({ method = 'GET', url, headers = {}, body, signal } = {}) {
    const verb = String(method).toUpperCase()
    if (!METHODS.includes(verb)) throw apiFail('INVALID_ARGUMENT', `method must be one of ${METHODS.join(', ')}.`)
    if (!RECORD(headers) || Object.keys(headers).length > API_LIMITS.headers) throw apiFail('INVALID_ARGUMENT', 'headers must be a bounded object.')
    for (const key of Object.keys(headers)) if (/^(?:host|cookie|authorization|proxy-authorization)$/i.test(key) && !Object.hasOwn(credentials, key)) throw apiFail('INVALID_ARGUMENT', `Header ${key} requires explicitly configured credentials.`)
    if (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body) > API_LIMITS.requestBytes)) throw apiFail('REQUEST_TOO_LARGE', 'Request body must be a string within the bound.')
    let current = assertDestination(url)
    const requestHeaders = { ...headers, ...credentials }
    let response, redirects = 0
    for (;;) {
      signal?.throwIfAborted()
      response = await fetchImpl(current.href, { method: verb, headers: requestHeaders, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      if (++redirects > maxRedirects) throw apiFail('TOO_MANY_REDIRECTS', 'Redirect limit exceeded.')
      const location = response.headers.get('location')
      if (!location) break
      current = assertDestination(new URL(location, current).href)
      // Credentials never follow a cross-origin redirect.
      if (Object.keys(credentials).length && new URL(location, current).origin !== current.origin) throw apiFail('REDIRECT_CREDENTIALS', 'Credentials are not forwarded across origins.')
    }
    const text = (await response.text()).slice(0, API_LIMITS.responseBytes)
    const headersOut = {}
    response.headers.forEach((value, key) => { headersOut[key] = /set-cookie|authorization/i.test(key) ? '[REDACTED]' : value })
    return { mode: 'host', status: response.status, ok: response.ok, url: current.href, headers: headersOut, body: text, redirected: redirects > 0, redirects, durationMs: null, note: 'Host-mode request with separate credentials; not a page/UI request. Allowed origins: ' + allowedList.join(', ') }
  }
}
/** Local fetch-rule simulation: page JavaScript only, not protocol interception or real throttling. */
export function createFetchRules({ now = Date.now, limits = API_LIMITS } = {}) {
  const rules = new Map()
  const timers = new Set()
  const match = (pattern, url) => {
    if (typeof pattern === 'string') return url.includes(pattern)
    if (pattern instanceof RegExp) return pattern.test(url)
    throw apiFail('INVALID_ARGUMENT', 'Rule pattern must be a string or RegExp.')
  }
  return {
    add({ pattern, kind = 'mock', status = 200, body = '', delayMs = 0, headers = {}, durationMs = null }) {
      if (!['mock', 'error', 'delay'].includes(kind)) throw apiFail('INVALID_ARGUMENT', 'kind must be mock, error or delay.')
      if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > limits.delayMs) throw apiFail('INVALID_ARGUMENT', `delayMs must be 0–${limits.delayMs}.`)
      if (rules.size >= limits.mocks) throw apiFail('RULE_LIMIT', 'Too many active fetch rules.')
      const id = `rule-${rules.size + 1}-${now()}`
      const rule = { id, pattern, kind, status, body: String(body).slice(0, limits.responseBytes), delayMs, headers, expiresAt: durationMs === null ? null : now() + durationMs }
      rules.set(id, rule)
      if (rule.expiresAt !== null) { const timer = setTimeout(() => { rules.delete(id); timers.delete(timer) }, Math.max(0, rule.expiresAt - now())); timers.add(timer) }
      return { id, kind, expiresAt: rule.expiresAt, note: 'Simulation inside page JavaScript; not protocol interception or real network throttling.' }
    },
    list() { for (const [id, rule] of rules) if (rule.expiresAt !== null && now() >= rule.expiresAt) rules.delete(id); return [...rules.values()].map(({ id, kind, delayMs, expiresAt }) => ({ id, kind, delayMs, expiresAt })) },
    /** Resolve a simulated response for a URL, or undefined when no rule matches. */
    resolve(url) {
      for (const rule of this.list()) { void rule; }
      for (const rule of rules.values()) {
        if (!match(rule.pattern, url)) continue
        if (rule.kind === 'error') return { simulated: true, error: 'SIMULATED_ERROR' }
        if (rule.kind === 'delay') return { simulated: true, delayMs: rule.delayMs }
        return { simulated: true, status: rule.status, body: rule.body, headers: rule.headers }
      }
      return undefined
    },
    teardown(id) { if (id === undefined) { rules.clear(); for (const timer of timers) clearTimeout(timer); timers.clear(); return { removed: 'all' } } if (!rules.delete(id)) throw apiFail('UNKNOWN_RULE', 'Unknown fetch rule.'); return { removed: id } }
  }
}
/** Replay a captured request with manual edits; mutating replays are never automatic. */
export function planReplay(captured, edits = {}) {
  if (!RECORD(captured) || typeof captured.url !== 'string' || typeof captured.method !== 'string') throw apiFail('INVALID_ARGUMENT', 'A captured request is required.')
  if (!RECORD(edits)) throw apiFail('INVALID_ARGUMENT', 'edits must be an object.')
  const method = String(edits.method ?? captured.method).toUpperCase()
  const request = { method, url: String(edits.url ?? captured.url), headers: { ...(captured.headers ?? {}), ...(edits.headers ?? {}) }, body: edits.body ?? captured.body }
  return { request, mutating: !['GET', 'HEAD', 'OPTIONS'].includes(method), automaticRetry: false, requiresConfirmation: !['GET', 'HEAD', 'OPTIONS'].includes(method), note: 'Replay is manual; mutating requests are never retried automatically.' }
}
export function compareResponses(before, after) {
  if (!RECORD(before) || !RECORD(after)) throw apiFail('INVALID_ARGUMENT', 'Two responses are required.')
  const parse = value => { try { return JSON.parse(value) } catch { return undefined } }
  const a = parse(before.body), b = parse(after.body)
  const keys = value => value && typeof value === 'object' ? Object.keys(value).sort() : []
  return { statusChanged: before.status !== after.status, before: before.status, after: after.status, headerChanges: Object.keys({ ...(before.headers ?? {}), ...(after.headers ?? {}) }).filter(key => (before.headers?.[key] ?? null) !== (after.headers?.[key] ?? null)), jsonShapeChanged: JSON.stringify(keys(a)) !== JSON.stringify(keys(b)), beforeKeys: keys(a), afterKeys: keys(b) }
}
export function toCurl(request, redactor = value => value) {
  if (!RECORD(request) || typeof request.url !== 'string') throw apiFail('INVALID_ARGUMENT', 'A request is required.')
  const parts = ['curl -X', String(request.method ?? 'GET').toUpperCase(), JSON.stringify(redactor(request.url))]
  for (const [key, value] of Object.entries(request.headers ?? {})) parts.push('-H', JSON.stringify(redactor(`${key}: ${String(value)}`)))
  if (typeof request.body === 'string') parts.push('--data', JSON.stringify(redactor(request.body)))
  return parts.join(' ')
}
export function toFetchSnippet(request, redactor = value => value) {
  if (!RECORD(request) || typeof request.url !== 'string') throw apiFail('INVALID_ARGUMENT', 'A request is required.')
  // Redact the whole serialized snippet so header values are covered too.
  return redactor(`fetch(${JSON.stringify(request.url)}, ${JSON.stringify({ method: request.method ?? 'GET', headers: request.headers ?? {}, ...(request.body !== undefined ? { body: String(request.body) } : {}) })})`)
}
/** Explicitly incomplete OpenAPI draft from observed evidence. */
export function toOpenApiDraft(map, { title = 'Observed API (incomplete)' } = {}) {
  if (!RECORD(map) || !Array.isArray(map.endpoints)) throw apiFail('INVALID_ARGUMENT', 'An API map is required.')
  const paths = {}
  for (const endpoint of map.endpoints) {
    if (typeof endpoint.endpoint !== 'string' || typeof endpoint.method !== 'string') continue
    paths[endpoint.endpoint] ??= {}
    paths[endpoint.endpoint][endpoint.method.toLowerCase()] = { summary: `Observed ${endpoint.requestIds?.length ?? 0} time(s)`, responses: Object.fromEntries((endpoint.statuses ?? []).map(status => [String(status), { description: `Observed status ${status}` }])) }
  }
  return { openapi: '3.1.0', info: { title, version: '0.0.0-observed' }, paths, 'x-incomplete': true, 'x-note': 'Draft from observed evidence; not a server contract. No introspection or aggressive scanning was performed.' }
}
export const API_SAFETY = Object.freeze({ noAutomaticMutatingRetry: true, noGraphqlIntrospection: true, hostModeExcludesLoopback: true, hostModeSeparateCredentials: true, simulationsArePageJavaScript: true })
