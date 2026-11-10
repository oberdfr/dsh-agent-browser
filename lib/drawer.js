// Pure drawer model for Network/API, Console, Test and Reports. Rendering stays in the plugin UI; this module
// only filters, pages and groups evidence so the model and the drawer see the same bounded view.
const drawerFail = (code, message) => Object.assign(new Error(message), { code })
const DRAWER_RECORD = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const DRAWER_TABS = Object.freeze(['network', 'console', 'test', 'reports'])
export const DRAWER_LIMITS = Object.freeze({ pageSize: 50, maxPageSize: 200, groupErrors: true })
export function openDrawer(state = {}) {
  const tab = DRAWER_TABS.includes(state.tab) ? state.tab : 'network'
  return { open: true, tab, query: typeof state.query === 'string' ? state.query.slice(0, 200) : '', filters: DRAWER_RECORD(state.filters) ? { ...state.filters } : {}, page: 0 }
}
export function selectDrawerTab(state, tab) {
  if (!DRAWER_TABS.includes(tab)) throw drawerFail('INVALID_TAB', `tab must be one of ${DRAWER_TABS.join(', ')}.`)
  return { ...state, tab, page: 0 }
}
export function setDrawerQuery(state, query) {
  if (typeof query !== 'string') throw drawerFail('INVALID_ARGUMENT', 'query must be a string.')
  return { ...state, query: query.slice(0, 200), page: 0 }
}
const textOf = item => JSON.stringify(item ?? {}).toLowerCase()
export function filterDrawerItems(items, { query = '', filters = {} } = {}) {
  if (!Array.isArray(items)) throw drawerFail('INVALID_ARGUMENT', 'items must be an array.')
  const needle = query.trim().toLowerCase()
  return items.filter(item => {
    if (needle && !textOf(item).includes(needle)) return false
    if (filters.method && String(item?.method ?? '').toUpperCase() !== String(filters.method).toUpperCase()) return false
    if (filters.level && String(item?.level ?? '') !== String(filters.level)) return false
    if (filters.status !== undefined && Number(item?.status) !== Number(filters.status)) return false
    if (filters.failed === true && !(item?.ok === false || (Number(item?.status) >= 400) || item?.error)) return false
    return true
  })
}
export function pageDrawerItems(items, { page = 0, pageSize = DRAWER_LIMITS.pageSize } = {}) {
  if (!Number.isSafeInteger(page) || page < 0) throw drawerFail('INVALID_ARGUMENT', 'page must be a non-negative integer.')
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > DRAWER_LIMITS.maxPageSize) throw drawerFail('INVALID_ARGUMENT', `pageSize must be 1–${DRAWER_LIMITS.maxPageSize}.`)
  const total = items.length
  const start = page * pageSize
  return { items: items.slice(start, start + pageSize), total, page, pageSize, nextPage: start + pageSize < total ? page + 1 : null }
}
/** Repeated console errors are grouped, newest first, with a bounded sample. */
export function groupConsoleErrors(entries, { sample = 3 } = {}) {
  if (!Array.isArray(entries)) throw drawerFail('INVALID_ARGUMENT', 'entries must be an array.')
  const groups = new Map()
  for (const entry of entries) {
    const key = `${entry?.level ?? 'log'}:${String(entry?.text ?? '').replace(/\d+/g, '#').slice(0, 120)}`
    const group = groups.get(key) ?? { level: entry?.level ?? 'log', pattern: String(entry?.text ?? '').slice(0, 120), count: 0, samples: [] }
    group.count++
    if (group.samples.length < sample) group.samples.push(String(entry?.text ?? '').slice(0, 300))
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}
/** Detail view for one request: bounded body preview and comparison against another response. */
export function requestDetail(request, { maxBodyChars = 2000, compareWith } = {}) {
  if (!DRAWER_RECORD(request)) throw drawerFail('INVALID_ARGUMENT', 'A request is required.')
  const clip = value => typeof value === 'string' && value.length > maxBodyChars ? `${value.slice(0, maxBodyChars)}[TRUNCATED]` : value
  const detail = { id: request.id, method: request.method, url: request.url, status: request.status, durationMs: request.durationMs, headers: request.headers, requestBody: clip(request.body), responseBody: clip(request.responseBody), error: request.error }
  if (compareWith && DRAWER_RECORD(compareWith)) detail.comparison = { statusChanged: request.status !== compareWith.status, bodyLengthDelta: (request.responseBody?.length ?? 0) - (compareWith.responseBody?.length ?? 0) }
  return detail
}
/** UI-side authority never comes from page input: only a trusted event may share a tab. */
export function drawerActionAllowed(action, { trusted }) {
  if (action === 'share-tab' || action === 'close-user-tab' || action === 'send-report') return trusted === true
  return true
}
export const DRAWER_POLICY = Object.freeze({ pageInputNeverAuthorizes: true, noAutomaticSend: true, boundedBodies: true })
