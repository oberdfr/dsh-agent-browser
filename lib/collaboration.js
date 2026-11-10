// User-facing collaboration: recording of explicit user actions, issue reports and temporary UI changes.
// All payloads are redacted and bounded; nothing here can grant authority or send a message automatically.
import { createRedactor } from './redaction.js'

const collaborationFail = (code, message) => Object.assign(new Error(message), { code })
const SENSITIVE_INPUT = /password|passwd|pwd|secret|token|otp|card|iban|cvv|ssn|pin/i
export const RECORDING_LIMITS = Object.freeze({ actions: 300, reportEvidence: 20, screenshotBytes: 8 * 1024 * 1024 })
export function isSensitiveField(field = {}) {
  return field.type === 'password' || SENSITIVE_INPUT.test(String(field.name ?? '')) || SENSITIVE_INPUT.test(String(field.label ?? '')) || SENSITIVE_INPUT.test(String(field.autocomplete ?? ''))
}
/** Convert one observed user interaction into a redacted, bounded record. */
export function recordUserAction(action, { redactor = createRedactor() } = {}) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') throw collaborationFail('INVALID_ARGUMENT', 'A user action needs a type.')
  const base = { time: Number.isFinite(action.time) ? action.time : Date.now(), type: action.type.slice(0, 40), url: typeof action.url === 'string' ? redactor(action.url) : undefined }
  if (isSensitiveField(action.field)) return { ...base, redacted: true, field: redactor(String(action.field?.name ?? action.field?.label ?? 'sensitive')), value: '[REDACTED]' }
  const record = { ...base }
  for (const key of ['selector', 'role', 'label', 'text', 'value', 'key']) if (action[key] !== undefined) record[key] = redactor(String(action[key]).slice(0, 300))
  return record
}
export class UserRecorder {
  #actions = []
  #redactor
  constructor({ redactor = createRedactor(), limits = RECORDING_LIMITS } = {}) { this.#redactor = redactor; this.limits = limits; this.state = 'idle'; this.dropped = 0 }
  start() { if (this.state === 'recording') return { state: this.state }; this.state = 'recording'; this.#actions = []; this.dropped = 0; return { state: this.state, startedAt: Date.now() } }
  pause() { if (this.state === 'recording') this.state = 'paused'; return { state: this.state } }
  resume() { if (this.state === 'paused') this.state = 'recording'; return { state: this.state } }
  stop() { this.state = 'stopped'; return { state: this.state, actions: this.#actions.length, dropped: this.dropped } }
  record(action) {
    if (this.state !== 'recording') return { recorded: false, reason: 'not-recording' }
    if (this.#actions.length >= this.limits.actions) { this.dropped++; return { recorded: false, reason: 'limit' } }
    this.#actions.push(recordUserAction(action, { redactor: this.#redactor }))
    return { recorded: true, count: this.#actions.length }
  }
  /** The model receives a summary and a report id, never the whole recording. */
  summary(reportId) {
    if (typeof reportId !== 'string' || !reportId) throw collaborationFail('INVALID_ARGUMENT', 'reportId is required.')
    const types = {}
    for (const action of this.#actions) types[action.type] = (types[action.type] ?? 0) + 1
    const first = this.#actions[0]?.time, last = this.#actions.at(-1)?.time
    return { reportId, state: this.state, actions: this.#actions.length, dropped: this.dropped, byType: types, spanMs: first !== undefined && last !== undefined ? last - first : 0, redacted: true, note: 'Summary only; full recording stays in the plugin and is never sent automatically.' }
  }
  clear() { this.#actions = []; this.dropped = 0; this.state = 'idle' }
}
export function createIssueReport({ reportId, expected, actual, steps = [], evidence = [], viewport = {}, console = [], requests = [], redactor = createRedactor(), limits = RECORDING_LIMITS } = {}) {
  if (typeof reportId !== 'string' || !reportId) throw collaborationFail('INVALID_ARGUMENT', 'reportId is required.')
  if (typeof expected !== 'string' || typeof actual !== 'string') throw collaborationFail('INVALID_ARGUMENT', 'expected and actual descriptions are required.')
  if (!Array.isArray(steps) || steps.length > 50) throw collaborationFail('INVALID_ARGUMENT', 'steps must be an array of at most 50 entries.')
  if (!Array.isArray(evidence) || evidence.length > limits.reportEvidence) throw collaborationFail('INVALID_ARGUMENT', `evidence must be at most ${limits.reportEvidence} entries.`)
  const report = {
    reportId, createdAt: new Date().toISOString(), expected: redactor(expected.slice(0, 2000)), actual: redactor(actual.slice(0, 2000)),
    steps: steps.slice(0, 50).map(step => redactor(String(step).slice(0, 500))),
    evidence: evidence.slice(0, limits.reportEvidence).map(item => ({ kind: String(item?.kind ?? 'unknown').slice(0, 40), artifactId: typeof item?.artifactId === 'string' ? item.artifactId : undefined, note: typeof item?.note === 'string' ? redactor(item.note.slice(0, 500)) : undefined })),
    viewport: { width: Number(viewport.width) || null, height: Number(viewport.height) || null, dpr: Number(viewport.dpr) || null, scale: Number(viewport.scale) || null },
    console: console.slice(0, 20).map(entry => ({ level: String(entry?.level ?? '').slice(0, 10), text: redactor(String(entry?.text ?? '').slice(0, 400)) })),
    requests: requests.slice(0, 20).map(entry => ({ id: String(entry?.id ?? '').slice(0, 40), method: String(entry?.method ?? '').slice(0, 10), url: redactor(String(entry?.url ?? '').slice(0, 500)), status: Number.isInteger(entry?.status) ? entry.status : undefined })),
    attachments: 'Inserted into the composer draft with existing APIs; never sent automatically.',
    redacted: true
  }
  const text = JSON.stringify(report)
  if (Buffer.byteLength(text) > 65536) throw collaborationFail('REPORT_TOO_LARGE', 'Report exceeds the 64 KiB bound; attach artifacts instead of inline text.')
  return report
}
/** Temporary CSS/DOM changes with an explicit undo log; never touches project sources. */
export class TemporaryUiChanges {
  #log = []
  #apply
  constructor({ apply } = {}) { if (typeof apply !== 'function') throw collaborationFail('INVALID_ARGUMENT', 'apply(change) is required.'); this.#apply = apply }
  async change(change) {
    if (!change || typeof change !== 'object' || typeof change.selector !== 'string' || !change.selector.trim()) throw collaborationFail('INVALID_ARGUMENT', 'A temporary change needs a selector.')
    if (change.css !== undefined && (change.css === null || typeof change.css !== 'object' || Array.isArray(change.css))) throw collaborationFail('INVALID_ARGUMENT', 'css must be an object of property/value pairs.')
    const entry = { id: `ui-${this.#log.length + 1}`, selector: change.selector.slice(0, 500), css: change.css ?? null, text: typeof change.text === 'string' ? change.text.slice(0, 5000) : null, appliedAt: Date.now() }
    await this.#apply(entry)
    this.#log.push(entry)
    return { id: entry.id, applied: true, temporary: true, note: 'Temporary page-only change; project sources are untouched. Use undo to restore.' }
  }
  undo(id) {
    const index = this.#log.findIndex(entry => entry.id === id)
    if (index < 0) throw collaborationFail('UNKNOWN_CHANGE', 'Unknown temporary UI change.')
    const [entry] = this.#log.splice(index, 1)
    return this.#apply({ ...entry, undo: true })
  }
  list() { return this.#log.map(({ id, selector, appliedAt }) => ({ id, selector, appliedAt })) }
  async undoAll() { const entries = this.#log.splice(0); for (const entry of entries.reverse()) await this.#apply({ ...entry, undo: true }); return { undone: entries.length } }
}
/** Composer attachment staging: produces the draft payload only; sending stays a user action. */
export function draftAttachmentPlan({ report, screenshot, supportsImages = false }) {
  if (!report || typeof report.reportId !== 'string') throw collaborationFail('INVALID_ARGUMENT', 'A report is required.')
  const text = `Problem report ${report.reportId}\nExpected: ${report.expected}\nActual: ${report.actual}\nSteps: ${report.steps.length}\nEvidence: ${report.evidence.map(item => item.artifactId ?? item.kind).join(', ')}`
  const attachments = screenshot && supportsImages ? [{ type: 'image', artifactId: String(screenshot.artifactId ?? '') }] : []
  return { text: text.slice(0, 4000), attachments, autoSend: false, requiresUserConfirmation: true }
}
export const COLLABORATION_LIMITS = Object.freeze({ recordingsInMemory: true, explicitSaveRequired: true, neverAutoSend: true, sensitiveFieldsExcluded: true })
