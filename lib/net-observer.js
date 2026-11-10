// Page-side observation wrapper. It is injected as a string into the guest document, never into the DSH renderer.
// Coverage is explicit: pre-hook requests have timing but no payload; workers and replaced wrappers are gaps.
export const NET_LIMITS = Object.freeze({ requests: 500, console: 200, bytesPerTab: 16 * 1024 * 1024, workspaceBytes: 64 * 1024 * 1024, bodyPreview: 64 * 1024, streams: 8, streamEvents: 200, callStack: true })
export function observerScript({ bodies = false, origins = [], callStack = false } = {}) {
  const config = JSON.stringify({ bodies: bodies === true, origins: Array.isArray(origins) ? origins.filter(value => typeof value === 'string').slice(0, 20) : [], callStack: callStack === true, limits: NET_LIMITS })
  return `(() => {
  const KEY = '__browserDshObserverV1';
  if (globalThis[KEY]?.installed) return { installed: true, reused: true, attachedAt: globalThis[KEY].attachedAt };
  const config = ${config};
  const state = { installed: true, attachedAt: Date.now(), requests: [], console: [], sockets: [], events: [], dropped: { requests: 0, console: 0, bytes: 0, streams: 0 }, bytes: 0, wrappersReplaced: [], socketsHooked: 0, gaps: ['Requests started before this hook have Performance timing but no payload.', 'Worker, Service Worker and cross-origin frame traffic is not observed here.'], bodies: config.bodies, origins: config.origins };
  const push = (bucket, value) => { const list = state[bucket]; list.push(value); if (list.length > (bucket === 'console' ? config.limits.console : config.limits.requests)) { list.shift(); state.dropped[bucket]++; } };
  const clip = text => { const s = String(text ?? ''); if (s.length > config.limits.bodyPreview) { state.dropped.bytes += s.length - config.limits.bodyPreview; return s.slice(0, config.limits.bodyPreview) + '[TRUNCATED]'; } return s; };
  const allowed = url => { if (!state.bodies) return false; try { return state.origins.includes(new URL(url, location.href).origin); } catch { return false; } };
  const record = (entry) => { const item = { id: 'r' + (state.requests.length + state.dropped.requests + 1), time: Date.now(), ...entry }; push('requests', item); return item; };
  const original = { fetch: globalThis.fetch, xhrOpen: XMLHttpRequest.prototype.open, xhrSend: XMLHttpRequest.prototype.send, ws: globalThis.WebSocket, es: globalThis.EventSource, beacon: navigator.sendBeacon };
  const stack = () => config.callStack ? (new Error('call-site').stack || '').split('\\n').slice(2, 5).join('\\n').slice(0, 600) : undefined;
  globalThis.fetch = function (input, init) {
    const isRequest = typeof Request === 'function' && input instanceof Request;
    const url = typeof input === 'string' ? input : isRequest ? input.url : String(input);
    const method = String(init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    const started = Date.now(); const body = init?.body;
    const item = record({ source: 'fetch', method, url, stack: stack(), body: allowed(url) && typeof body === 'string' ? clip(body) : undefined });
    const pending = original.fetch.apply(this, arguments);
    pending.then(response => { item.status = response.status; item.ok = response.ok; item.type = response.type; item.durationMs = Date.now() - started; if (allowed(url)) { try { response.clone().text().then(text => { item.responseBody = clip(text); }).catch(() => { item.responseBodyError = 'unreadable' }); } catch { item.responseBodyError = 'clone-failed' } } }, error => { item.error = String(error?.name || 'network-error'); item.durationMs = Date.now() - started; });
    return pending;
  };
  const xhrOpen = original.xhrOpen, xhrSend = original.xhrSend;
  XMLHttpRequest.prototype.open = function (method, url) { this.__dsh = { method: String(method).toUpperCase(), url: String(url), stack: stack() }; return xhrOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) { const meta = this.__dsh || { method: 'GET', url: '' }; const started = Date.now(); const item = record({ source: 'xhr', method: meta.method, url: meta.url, stack: meta.stack, body: allowed(meta.url) && typeof body === 'string' ? clip(body) : undefined }); this.addEventListener('loadend', () => { item.status = this.status; item.durationMs = Date.now() - started; if (allowed(meta.url)) { try { item.responseBody = this.responseType === '' || this.responseType === 'text' ? clip(this.responseText) : '[binary:' + this.responseType + ']'; } catch { item.responseBodyError = 'unreadable' } } }); return xhrSend.apply(this, arguments); };
  if (typeof globalThis.WebSocket === 'function') {
    const Original = globalThis.WebSocket;
    const Wrapped = function (url, protocols) { const socket = protocols === undefined ? new Original(url) : new Original(url, protocols); const channel = { id: 'ws' + (++state.socketsHooked), url: String(url), open: Date.now(), sent: 0, received: 0, closed: false }; state.sockets.push(channel); if (state.sockets.length > config.limits.streams) { state.sockets.shift(); state.dropped.streams++; }
      socket.addEventListener('message', event => { channel.received++; if (state.events.length < config.limits.streamEvents) state.events.push({ channel: channel.id, direction: 'in', time: Date.now(), preview: typeof event.data === 'string' ? clip(event.data) : '[binary]' }); });
      socket.addEventListener('close', () => { channel.closed = true; channel.closedAt = Date.now(); });
      const send = socket.send; socket.send = function (data) { channel.sent++; if (state.events.length < config.limits.streamEvents) state.events.push({ channel: channel.id, direction: 'out', time: Date.now(), preview: typeof data === 'string' ? clip(data) : '[binary]' }); return send.apply(this, arguments); };
      return socket; };
    Wrapped.prototype = Original.prototype; for (const key of ['CONNECTING','OPEN','CLOSING','CLOSED']) Wrapped[key] = Original[key];
    globalThis.WebSocket = Wrapped;
  }
  if (typeof globalThis.EventSource === 'function') { const Original = globalThis.EventSource; const Wrapped = function (url, init) { const source = new Original(url, init); const channel = { id: 'sse' + (++state.socketsHooked), url: String(url), open: Date.now(), sent: 0, received: 0, closed: false }; state.sockets.push(channel); source.addEventListener('message', event => { channel.received++; if (state.events.length < config.limits.streamEvents) state.events.push({ channel: channel.id, direction: 'in', time: Date.now(), preview: clip(event.data) }); }); return source; }; Wrapped.prototype = Original.prototype; globalThis.EventSource = Wrapped; }
  if (typeof navigator.sendBeacon === 'function') navigator.sendBeacon = function (url, data) { record({ source: 'beacon', method: 'POST', url: String(url), body: allowed(url) && typeof data === 'string' ? clip(data) : undefined }); return original.beacon.apply(this, arguments); };
  const installedFetch = globalThis.fetch, installedWebSocket = globalThis.WebSocket;
  const check = () => { if (globalThis.fetch !== installedFetch && !state.wrappersReplaced.includes('fetch')) state.wrappersReplaced.push('fetch'); if (globalThis.WebSocket !== installedWebSocket && !state.wrappersReplaced.includes('WebSocket')) state.wrappersReplaced.push('WebSocket'); };
  const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) { if (state.requests.length >= config.limits.requests) { state.dropped.requests++; continue; } if (!state.requests.some(r => r.url === entry.name && Math.abs(r.time - (performance.timeOrigin + entry.startTime)) < 50)) push('requests', { id: 'p' + state.requests.length, source: 'performance', time: Math.round(performance.timeOrigin + entry.startTime), url: entry.name, initiatorType: entry.initiatorType, durationMs: Math.round(entry.duration), transferSize: entry.transferSize, crossOriginTimingExposed: entry.responseStart > 0, note: 'Timing only; no status/body from Resource Timing.' }); } });
  try { observer.observe({ type: 'resource', buffered: true }); } catch { state.gaps.push('PerformanceObserver resource unavailable'); }
  const consoleOriginal = { warn: console.warn, error: console.error };
  for (const level of ['warn', 'error']) console[level] = function (...args) { push('console', { level, time: Date.now(), text: clip(args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ')) }); return consoleOriginal[level].apply(this, args); };
  Object.defineProperty(globalThis, KEY, { value: { installed: true, attachedAt: state.attachedAt, snapshot: () => ({ ...state, limits: config.limits, requests: state.requests.slice(-config.limits.requests), console: state.console.slice(-config.limits.console), events: state.events.slice(-config.limits.streamEvents), wrappersReplaced: (check(), state.wrappersReplaced) }), setBodies: (enabled, origins) => { state.bodies = enabled === true; state.origins = Array.isArray(origins) ? origins.filter(o => typeof o === 'string').slice(0, 20) : []; }, dispose: () => { globalThis.fetch = original.fetch; XMLHttpRequest.prototype.open = xhrOpen; XMLHttpRequest.prototype.send = xhrSend; if (original.ws) globalThis.WebSocket = original.ws; if (original.es) globalThis.EventSource = original.es; if (original.beacon) navigator.sendBeacon = original.beacon; console.warn = consoleOriginal.warn; console.error = consoleOriginal.error; observer.disconnect(); delete globalThis[KEY]; } }, configurable: true });
  return { installed: true, reused: false, attachedAt: state.attachedAt, limits: config.limits };
})()`
}
/** Correlation is temporal evidence, not proof of causality. */
export function correlateActions(actions, requests, windowMs = 2000) {
  const list = Array.isArray(actions) ? actions.filter(a => Number.isFinite(a?.time)) : []
  const observed = Array.isArray(requests) ? requests.filter(r => Number.isFinite(r?.time)) : []
  return list.map(action => ({ actionId: action.id, time: action.time, related: observed.filter(request => request.time >= action.time && request.time - action.time <= windowMs).map(request => request.id), basis: 'temporal-window', causal: false }))
}
/** Evidence-based inventory: groups are inferences with requestIds, not a server contract. */
export function buildApiMap(requests) {
  const groups = new Map()
  for (const request of Array.isArray(requests) ? requests : []) {
    if (!request || typeof request.url !== 'string') continue
    let url
    try { url = new URL(request.url, 'http://placeholder.invalid') } catch { continue }
    const path = url.pathname.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}(?=\/|$)/gi, '/:uuid')
    const key = `${request.method || 'GET'} ${path}`
    const group = groups.get(key) ?? { endpoint: path, method: request.method || 'GET', requestIds: [], queryKeys: new Set(), bodyKeys: new Set(), statuses: new Set(), responseKeys: new Set(), errors: 0 }
    group.requestIds.push(request.id)
    for (const key2 of url.searchParams.keys()) group.queryKeys.add(key2)
    if (typeof request.body === 'string') { try { const parsed = JSON.parse(request.body); if (parsed && typeof parsed === 'object') for (const key3 of Object.keys(parsed)) group.bodyKeys.add(key3) } catch {} }
    if (Number.isInteger(request.status)) group.statuses.add(request.status)
    if (request.status >= 500 || request.error) group.errors++
    if (typeof request.responseBody === 'string') { try { const parsed = JSON.parse(request.responseBody); if (parsed && typeof parsed === 'object') for (const key4 of Object.keys(parsed)) group.responseKeys.add(key4) } catch {} }
    groups.set(key, group)
  }
  return { endpoints: [...groups.values()].map(group => ({ ...group, requestIds: group.requestIds.slice(0, 50), queryKeys: [...group.queryKeys], bodyKeys: [...group.bodyKeys], statuses: [...group.statuses], responseKeys: [...group.responseKeys] })), inference: true, note: 'Grouping and shapes are inferences from observed evidence, not a complete server contract.' }
}
export const NET_GAPS = Object.freeze(['Pre-hook calls: timing only, no payload.', 'Worker/Service-Worker and cross-origin frame traffic unobserved.', 'Replaced page wrappers and document teardown are reported, not repaired.', 'No full Chromium network stack, no HttpOnly cookie values.'])
