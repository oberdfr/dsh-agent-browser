// Browser DSH — ControllerRegistry (fondazione pura, zero dipendenze runtime).
//
// Responsabilità: legare un "controller" client (già autenticato Host) a una
// registrazione per (peer object, windowId, controllerId), consegnare comandi
// RPC at-most-once e correlare i risultati in modo stretto.
//
// Confini espliciti:
//  - Il peer è già autenticato dall'Host: qui si verifica solo principal.kind
//    === 'owner' e l'assenza di abort.
//  - sessionId/workspace dichiarati dal client NON sono autorità: il route Host
//    deve validarli prima di register/poll/submit/deregister. Questo modulo li
//    usa solo per correlare (binding) e per l'instradamento di dispatch().
//  - connectionGeneration è un'etichetta client obbligatoria, non autenticazione.
//  - Nessuna telemetria, nessun I/O, nessun timer globale: now/setTimer/clearTimer
//    sono iniettabili per i test.
//
// Consegna at-most-once: poll preleva i comandi dalla coda e li sposta in
// `delivered`; nessun replay su riconnessione. Se un comando non è ancora stato
// consegnato viene rimosso in silenzio; se è stato consegnato viene inviato un
// comando {type:'cancel', id} e un risultato tardivo non risolve la Promise.

import { randomUUID } from 'node:crypto'

const KIND = 'controller-registry'

/** Codici errore stabili, esposti via error.code. */
export const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_OWNER: 'NOT_OWNER',
  PEER_ABORTED: 'PEER_ABORTED',
  INVALID_FIELD: 'INVALID_FIELD',
  CONTROLLER_LIMIT: 'CONTROLLER_LIMIT',
  PENDING_LIMIT: 'PENDING_LIMIT',
  QUEUE_LIMIT: 'QUEUE_LIMIT',
  NOT_REGISTERED: 'NOT_REGISTERED',
  TOKEN_MISMATCH: 'TOKEN_MISMATCH',
  GENERATION_MISMATCH: 'GENERATION_MISMATCH',
  SESSION_MISMATCH: 'SESSION_MISMATCH',
  WORKSPACE_MISMATCH: 'WORKSPACE_MISMATCH',
  POLL_IN_FLIGHT: 'POLL_IN_FLIGHT',
  POLL_ABORTED: 'POLL_ABORTED',
  INVALID_RESULTS: 'INVALID_RESULTS',
  RESULTS_TOO_MANY: 'RESULTS_TOO_MANY',
  RESULT_UNKNOWN: 'RESULT_UNKNOWN',
  RESULT_NOT_DELIVERED: 'RESULT_NOT_DELIVERED',
  RESULT_DUPLICATE: 'RESULT_DUPLICATE',
  RESULT_FOREIGN: 'RESULT_FOREIGN',
  NO_CONTROLLER: 'NO_CONTROLLER',
  AMBIGUOUS_CONTROLLER: 'AMBIGUOUS_CONTROLLER',
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  ACTION_ABORTED: 'ACTION_ABORTED',
  ACTION_CANCELLED: 'ACTION_CANCELLED',
  ACTION_FAILED: 'ACTION_FAILED',
  CAPTURE_TIMEOUT: 'CAPTURE_TIMEOUT',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  REGISTRY_CLOSED: 'REGISTRY_CLOSED',
})

// Messaggi statici: nessun id, token, sessione o dato del chiamante.
const MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'Invalid argument.',
  NOT_OWNER: 'Only an owner peer may use the browser controller registry.',
  PEER_ABORTED: 'The peer is no longer connected.',
  INVALID_FIELD: 'A required field is missing or invalid.',
  CONTROLLER_LIMIT: 'Too many browser controllers are registered.',
  PENDING_LIMIT: 'Too many browser actions are pending.',
  QUEUE_LIMIT: 'The browser controller command queue is full.',
  NOT_REGISTERED: 'No matching browser controller registration.',
  TOKEN_MISMATCH: 'The controller token does not match.',
  GENERATION_MISMATCH: 'The controller generation does not match.',
  SESSION_MISMATCH: 'The controller is not bound to this session.',
  WORKSPACE_MISMATCH: 'The controller is not bound to this workspace.',
  POLL_IN_FLIGHT: 'A poll is already active for this controller.',
  POLL_ABORTED: 'The poll was aborted.',
  INVALID_RESULTS: 'The results payload is invalid.',
  RESULTS_TOO_MANY: 'Too many results were submitted.',
  RESULT_UNKNOWN: 'A result does not match any pending browser action.',
  RESULT_NOT_DELIVERED: 'A result was reported for an action that was never delivered.',
  RESULT_DUPLICATE: 'A result was reported more than once.',
  RESULT_FOREIGN: 'A result does not belong to this controller.',
  NO_CONTROLLER: 'No browser controller is connected for this session and workspace.',
  AMBIGUOUS_CONTROLLER: 'More than one browser controller is connected for this session and workspace.',
  ACTION_TIMEOUT:
    'The browser action timed out. The outcome of the mutation is unknown; it was not retried automatically.',
  ACTION_ABORTED:
    'The browser action was aborted. The outcome of the mutation is unknown; it was not retried automatically.',
  ACTION_CANCELLED:
    'The browser action was cancelled. The outcome of the mutation is unknown; it was not retried automatically.',
  ACTION_FAILED: 'The browser action failed.',
  CAPTURE_TIMEOUT: 'The embedded webview did not return image pixels within the capture limit.',
  CAPTURE_FAILED: 'The embedded webview did not return a usable image.',
  // Codici Client noti: il messaggio resta statico e non riporta mai il testo del client.
  INVALID_STEP: 'The browser test step is invalid.',
  NOT_IMPLEMENTED: 'This browser operation is not available in this build.',
  LOCATOR_NOT_FOUND: 'The browser locator did not match any element.',
  UNKNOWN_REPORT: 'Unknown report; the user must create it first.',
  UNKNOWN_REQUEST: 'Unknown captured request id.',
  UNKNOWN_OP: 'Unknown browser operation; call help.',
  UNKNOWN_TAB: 'Unknown browser tab.',
  NO_TAB: 'No accessible browser page. Open a tab or ask the user to share one.',
  AMBIGUOUS_TAB: 'Several browser tabs match; pass tabId explicitly.',
  TAB_LIMIT: 'Browser tab limit reached.',
  TAB_CLOSED: 'Browser tab is closed.',
  TAB_NOT_OWNED: 'This tab belongs to another Session.',
  TAB_USER_OWNED: 'This user tab requires an explicit trusted UI handover; the model cannot close it.',
  CLAIM_DENIED: 'Only the browser UI may hand over a user tab.',
  CLAIM_NOT_HELD: 'This user tab is not shared with the caller.',
  ANNOTATION_ACTIVE: 'The user is annotating this page. Nothing was changed.',
  INPUT_FOCUS_REQUIRED: 'Native input requires this visible guest to already have focus; no focus was stolen.',
  STALE_DOCUMENT: 'The page document changed; references and pending waits are invalid.',
  HOST_MODE_REQUIRED: 'Host-mode requests run in the Host backend, not in the page.',
  UPLOAD_UNAVAILABLE: 'An authorized workspace file could not be read.',
  SCREENSHOT_PROOF_UNAVAILABLE: 'A screenshot proof needs an attachment store, which this build does not have.',
  PDF_NOT_SMOKE_TESTED: 'PDF capture is disabled until the packaged smoke test.',
  REGISTRY_CLOSED: 'The browser controller registry is closed.',
})

// Whitelist FINITA dei codici Client noti, verificati nelle sorgenti page-operations, tab-registry,
// image-operations, engine, test-runner e collaboration. Il messaggio resta sempre quello statico
// di MESSAGES: un codice sconosciuto non viene mai propagato come codice o testo del client.
const CLIENT_ERROR_CODES = new Set([
  'ACTION_ABORTED',
  'ACTION_FAILED',
  'CAPTURE_TIMEOUT',
  'CAPTURE_FAILED',
  'INVALID_ARGUMENT',
  'INVALID_STEP',
  'NOT_IMPLEMENTED',
  'LOCATOR_NOT_FOUND',
  'UNKNOWN_REPORT',
  'UNKNOWN_REQUEST',
  'UNKNOWN_OP',
  'UNKNOWN_TAB',
  'NO_TAB',
  'AMBIGUOUS_TAB',
  'TAB_LIMIT',
  'TAB_CLOSED',
  'TAB_NOT_OWNED',
  'TAB_USER_OWNED',
  'CLAIM_DENIED',
  'CLAIM_NOT_HELD',
  'ANNOTATION_ACTIVE',
  'INPUT_FOCUS_REQUIRED',
  'STALE_DOCUMENT',
  'HOST_MODE_REQUIRED',
  'UPLOAD_UNAVAILABLE',
  'SCREENSHOT_PROOF_UNAVAILABLE',
  'PDF_NOT_SMOKE_TESTED',
])

/** Errore con codice stabile e messaggio statico. */
export class ControllerRegistryError extends Error {
  constructor(code, message = MESSAGES[code] ?? MESSAGES.ACTION_FAILED) {
    super(message)
    this.name = 'ControllerRegistryError'
    // An unknown code never escapes: both code and message fall back to the static ACTION_FAILED.
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'ACTION_FAILED'
  }
}

function fail(code) {
  throw new ControllerRegistryError(code)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbortSignal(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
  )
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

function functionOption(value, name, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
  return value
}

/** Stringa non vuota, <= 4096 caratteri, senza surrogati isolati. */
function isBoundedString(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && value.isWellFormed() && !/[\u0000-\u001f]/.test(value)
}

function checkBounded(value, name) {
  if (!isBoundedString(value)) fail('INVALID_FIELD')
  return value
}

/** Valida un peer già autenticato dall'Host. */
function checkPeer(peer) {
  if (!isPlainObject(peer)) fail('INVALID_ARGUMENT')
  if (peer.signal !== undefined && peer.signal !== null) {
    if (!isAbortSignal(peer.signal)) fail('INVALID_ARGUMENT')
    if (peer.signal.aborted) fail('PEER_ABORTED')
  }
  const principal = peer.principal
  if (!isPlainObject(principal) || principal.kind !== 'owner') fail('NOT_OWNER')
  return peer
}

function checkSignal(signal) {
  if (signal === undefined || signal === null) return null
  if (!isAbortSignal(signal)) fail('INVALID_ARGUMENT')
  return signal
}

function checkResultsShape(results) {
  if (!Array.isArray(results)) fail('INVALID_RESULTS')
  if (results.length > 16) fail('RESULTS_TOO_MANY')
  const seen = new Set()
  for (const entry of results) {
    if (!isPlainObject(entry)) fail('INVALID_RESULTS')
    if (!isBoundedString(entry.id)) fail('INVALID_RESULTS')
    if (typeof entry.ok !== 'boolean') fail('INVALID_RESULTS')
    if (entry.ok) {
      if ('error' in entry) fail('INVALID_RESULTS')
    } else {
      if ('value' in entry) fail('INVALID_RESULTS')
      if (typeof entry.error !== 'string' || entry.error.length > 4096 || !entry.error.isWellFormed()) {
        fail('INVALID_RESULTS')
      }
    }
    if (seen.has(entry.id)) fail('RESULT_DUPLICATE')
    seen.add(entry.id)
  }
  return results
}

function isThenable(value) {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof value.then === 'function'
  )
}

/** Registrazione: stato per singolo controller attivo. */
class Registration {
  constructor({ peer, sessionId, workspace, windowId, controllerId, connectionGeneration, token, generation, expiresAt }) {
    this.peer = peer
    this.sessionId = sessionId
    this.workspace = workspace
    this.windowId = windowId
    this.controllerId = controllerId
    this.connectionGeneration = connectionGeneration
    this.token = token
    this.generation = generation
    this.expiresAt = expiresAt
    this.closed = false
    this.queue = [] // comandi non ancora consegnati (at-most-once)
    this.delivered = new Map() // id -> entry, comandi consegnati e non ancora risolti
    this.poll = null // { finish, cleanup } del poll attivo
    this.abortListener = null
    this.expiryTimer = null
  }
}

/** Azione in attesa di dispatch(). */
class Action {
  constructor({ id, registration, sessionId, workspace, action }) {
    this.id = id
    this.registration = registration
    this.sessionId = sessionId
    this.workspace = workspace
    this.action = action
    this.state = 'queued' // queued | delivered | settled
    this.callDelivered = false
    this.deliveredAt = 0
    this.resolve = null
    this.reject = null
    this.cleanup = null
    this.detach = null
  }
}

export class ControllerRegistry {
  #ttlMs
  #pollMs
  #actionMs
  #maxControllers
  #maxPending
  #maxQueue
  #now
  #setTimer
  #clearTimer
  #registrations = new Map() // chiave: peer object -> Map(windowId -> Map(controllerId -> Registration))
  #byPeer = new Map() // peer object -> Set<Registration>
  #actions = new Map() // id comando -> Action
  #pending = new Set() // Action non risolte (queued o delivered)
  #closed = false

  constructor(options = {}) {
    if (options === null || typeof options !== 'object') throw new TypeError('options must be an object')
    const {
      ttlMs = 45000,
      pollMs = 15000,
      actionMs = 45000,
      maxControllers = 64,
      maxPending = 256,
      maxQueue = 64,
      now = Date.now,
      setTimer = setTimeout,
      clearTimer = clearTimeout,
    } = options
    this.#ttlMs = positiveInteger(ttlMs, 'ttlMs', 45000)
    this.#pollMs = positiveInteger(pollMs, 'pollMs', 15000)
    this.#actionMs = positiveInteger(actionMs, 'actionMs', 45000)
    this.#maxControllers = positiveInteger(maxControllers, 'maxControllers', 64)
    this.#maxPending = positiveInteger(maxPending, 'maxPending', 256)
    this.#maxQueue = positiveInteger(maxQueue, 'maxQueue', 64)
    this.#now = functionOption(now, 'now', Date.now)
    this.#setTimer = functionOption(setTimer, 'setTimer', setTimeout)
    this.#clearTimer = functionOption(clearTimer, 'clearTimer', clearTimeout)
    if (this.#pollMs > 15000) throw new TypeError('pollMs must not exceed 15000')
  }

  // ---------------------------------------------------------------- registro

  register({ peer, sessionId, workspace, windowId, controllerId, connectionGeneration } = {}) {
    this.#assertOpen()
    checkPeer(peer)
    checkBounded(sessionId, 'sessionId')
    checkBounded(workspace, 'workspace')
    checkBounded(windowId, 'windowId')
    checkBounded(controllerId, 'controllerId')
    checkBounded(connectionGeneration, 'connectionGeneration')

    const now = this.#now()
    this.#prune(now)

    const byWindow = this.#registrations.get(peer)
    const existing = byWindow?.get(windowId)?.get(controllerId)
    if (existing && existing.sessionId !== sessionId) fail('SESSION_MISMATCH')
    if (existing && existing.workspace !== workspace) fail('WORKSPACE_MISMATCH')
    // Identità immutabile: la riconnessione può ruotare il lease, non cambiare Session/workspace.
    if (!existing && this.#countRegistrations() >= this.#maxControllers) fail('CONTROLLER_LIMIT')

    const token = randomUUID()
    const generation = randomUUID()
    const expiresAt = now + this.#ttlMs
    const registration = new Registration({
      peer,
      sessionId,
      workspace,
      windowId,
      controllerId,
      connectionGeneration,
      token,
      generation,
      expiresAt,
    })

    if (existing) this.#revoke(existing, 'replaced', now)

    let windows = this.#registrations.get(peer)
    if (!windows) {
      windows = new Map()
      this.#registrations.set(peer, windows)
    }
    let slot = windows.get(windowId)
    if (!slot) {
      slot = new Map()
      windows.set(windowId, slot)
    }
    slot.set(controllerId, registration)

    let set = this.#byPeer.get(peer)
    if (!set) {
      set = new Set()
      this.#byPeer.set(peer, set)
    }
    set.add(registration)

    const signal = peer.signal
    if (signal) {
      const onAbort = () => this.#revoke(registration, 'peer-aborted', this.#now())
      registration.abortListener = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }

    this.#refresh(registration, now)
    return { token, generation, expiresAt }
  }

  deregister({ peer, token, generation, sessionId, workspace } = {}) {
    this.#assertOpen()
    checkPeer(peer)
    const registration = this.#authorize(peer, { token, generation, sessionId, workspace })
    this.#revoke(registration, 'deregistered', this.#now())
    return { closed: true }
  }

  // ------------------------------------------------------------------- poll

  poll({ peer, token, generation, sessionId, workspace, signal, timeoutMs } = {}) {
    this.#assertOpen()
    checkPeer(peer)
    const registration = this.#authorize(peer, { token, generation, sessionId, workspace })
    const abortSignal = checkSignal(signal)
    if (abortSignal?.aborted) return Promise.reject(new ControllerRegistryError('POLL_ABORTED'))
    if (registration.poll) return Promise.reject(new ControllerRegistryError('POLL_IN_FLIGHT'))

    const now = this.#now()
    if (now >= registration.expiresAt) {
      this.#revoke(registration, 'expired', now)
      return Promise.reject(new ControllerRegistryError('NOT_REGISTERED'))
    }
    let requested = this.#pollMs
    if (timeoutMs !== undefined) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 15000) {
        return Promise.reject(new ControllerRegistryError('INVALID_ARGUMENT'))
      }
      requested = Math.min(this.#pollMs, timeoutMs)
    }
    // Solo una richiesta interamente valida rinnova il lease.
    this.#refresh(registration, now)
    const waitMs = Math.min(requested, registration.expiresAt - now)

    return new Promise((resolve, reject) => {
      let done = false
      const finish = (error, value) => {
        if (done) return
        done = true
        if (registration.poll && registration.poll.finish === finish) registration.poll = null
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
        if (timer !== undefined) this.#clearTimer(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const onAbort = () => finish(new ControllerRegistryError('POLL_ABORTED'))
      const timer = this.#setTimer(() => {
        const at = this.#now()
        if (at >= registration.expiresAt) {
          this.#revoke(registration, 'expired', at)
          finish(new ControllerRegistryError('NOT_REGISTERED'))
          return
        }
        finish(null, { commands: this.#drain(registration, at), expiresAt: registration.expiresAt })
      }, waitMs)
      registration.poll = { finish }
      if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true })

      // Comandi già in coda: consegna immediata, senza busy polling.
      if (registration.queue.length > 0) {
        finish(null, { commands: this.#drain(registration, now), expiresAt: registration.expiresAt })
      }
    })
  }

  // ----------------------------------------------------------------- submit

  submit({ peer, token, generation, sessionId, workspace, results } = {}) {
    this.#assertOpen()
    checkPeer(peer)
    const registration = this.#authorize(peer, { token, generation, sessionId, workspace })
    const list = checkResultsShape(results)
    const now = this.#now()

    // Fase 1 (atomica, nessun effetto): ogni risultato deve correlare a un
    // comando consegnato a QUESTA registrazione, una sola volta.
    const seen = new Set()
    for (const entry of list) {
      const action = this.#actions.get(entry.id)
      if (!action) fail('RESULT_UNKNOWN')
      if (action.registration !== registration) fail('RESULT_FOREIGN')
      if (seen.has(entry.id)) fail('RESULT_DUPLICATE')
      seen.add(entry.id)
      if (action.state === 'queued') fail('RESULT_NOT_DELIVERED')
      if (action.state === 'settled') fail('RESULT_DUPLICATE')
    }

    // Fase 2: applica.
    for (const entry of list) {
      const action = this.#actions.get(entry.id)
      this.#settle(action, entry.ok, entry.ok ? entry.value : entry.error, now)
    }
    return { accepted: list.length }
  }

  // --------------------------------------------------------------- dispatch

  dispatch({ sessionId, workspace } = {}, action, args, signal) {
    try {
      this.#assertOpen()
      checkBounded(sessionId, 'sessionId')
      checkBounded(workspace, 'workspace')
      if (!isBoundedString(action)) fail('INVALID_ARGUMENT')
      const abortSignal = checkSignal(signal)
      if (abortSignal?.aborted) {
        return Promise.reject(new ControllerRegistryError('ACTION_ABORTED'))
      }

      const now = this.#now()
      this.#prune(now)

      const candidates = []
      for (const registration of this.#byPeer.values()) {
        for (const item of registration) {
          if (item.sessionId === sessionId && item.workspace === workspace) candidates.push(item)
        }
      }
      if (candidates.length === 0) return Promise.reject(new ControllerRegistryError('NO_CONTROLLER'))
      if (candidates.length > 1) return Promise.reject(new ControllerRegistryError('AMBIGUOUS_CONTROLLER'))
      const registration = candidates[0]

      if (this.#pending.size >= this.#maxPending) {
        return Promise.reject(new ControllerRegistryError('PENDING_LIMIT'))
      }
      if (registration.queue.length >= this.#maxQueue) {
        return Promise.reject(new ControllerRegistryError('QUEUE_LIMIT'))
      }

      const id = randomUUID()
      const command = {
        type: 'rpc',
        id,
        action,
        parameters: args,
        context: { sessionId, workspace },
      }
      const entry = new Action({ id, registration, sessionId, workspace, action })
      this.#actions.set(id, entry)
      this.#pending.add(entry)
      registration.queue.push(command)

      return new Promise((resolve, reject) => {
        entry.resolve = resolve
        entry.reject = reject
        const timer = this.#setTimer(() => {
          this.#cancel(entry, 'ACTION_TIMEOUT', this.#now())
        }, this.#actionMs)
        const onAbort = () => this.#cancel(entry, 'ACTION_ABORTED', this.#now())
        entry.cleanup = () => {
          this.#clearTimer(timer)
          if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
        }
        if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true })

        // Consegna immediata se il controller sta già pollando.
        if (registration.poll && !registration.closed) {
          const poll = registration.poll
          this.#markDelivered(entry, now)
          poll.finish(null, { commands: this.#drain(registration, now), expiresAt: registration.expiresAt })
        }
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  // ------------------------------------------------------------------ close

  close() {
    if (this.#closed) return
    this.#closed = true
    const now = this.#now()
    const registrations = []
    for (const set of this.#byPeer.values()) for (const registration of set) registrations.push(registration)
    for (const registration of registrations) this.#revoke(registration, 'closed', now)
    // Rete di sicurezza: nessuna azione deve sopravvivere al registro.
    for (const action of [...this.#pending]) this.#cancel(action, 'ACTION_CANCELLED', now)
    this.#registrations.clear()
    this.#byPeer.clear()
    this.#actions.clear()
    this.#pending.clear()
  }

  // --------------------------------------------------------------- interni

  #assertOpen() {
    if (this.#closed) fail('REGISTRY_CLOSED')
  }

  #countRegistrations() {
    let total = 0
    for (const set of this.#byPeer.values()) total += set.size
    return total
  }

  #findRegistration(peer, windowId, controllerId) {
    return this.#registrations.get(peer)?.get(windowId)?.get(controllerId) ?? null
  }

  /** Autorizza una richiesta del controller già registrato (token+generation+binding). */
  #authorize(peer, { token, generation, sessionId, workspace }) {
    this.#prune(this.#now())
    checkBounded(sessionId)
    checkBounded(workspace)
    if (typeof token !== 'string' || !isBoundedString(token)) fail('INVALID_FIELD')
    if (typeof generation !== 'string' || !isBoundedString(generation)) fail('INVALID_FIELD')
    const registration = this.#findByToken(peer, token)
    if (!registration) fail('NOT_REGISTERED')
    if (registration.token !== token) fail('TOKEN_MISMATCH')
    if (registration.generation !== generation) fail('GENERATION_MISMATCH')
    if (sessionId !== undefined && sessionId !== registration.sessionId) fail('SESSION_MISMATCH')
    if (workspace !== undefined && workspace !== registration.workspace) fail('WORKSPACE_MISMATCH')
    return registration
  }

  #findByToken(peer, token) {
    const set = this.#byPeer.get(peer)
    if (!set) return null
    for (const registration of set) {
      if (registration.token === token) return registration
    }
    return null
  }

  #refresh(registration, now) {
    if (registration.expiryTimer !== null) this.#clearTimer(registration.expiryTimer)
    registration.expiresAt = now + this.#ttlMs
    registration.expiryTimer = this.#setTimer(() => {
      registration.expiryTimer = null
      if (this.#now() >= registration.expiresAt) this.#revoke(registration, 'expired', this.#now())
      else this.#refresh(registration, registration.expiresAt - this.#ttlMs)
    }, Math.max(0, registration.expiresAt - this.#now()))
  }

  /** Pruna registrazioni scadute e mappe vuote. */
  #prune(now) {
    const expired = []
    for (const set of this.#byPeer.values()) {
      for (const registration of set) {
        if (now >= registration.expiresAt) expired.push(registration)
      }
    }
    for (const registration of expired) this.#revoke(registration, 'expired', now)
  }

  #unlink(registration) {
    const windows = this.#registrations.get(registration.peer)
    const slot = windows?.get(registration.windowId)
    if (slot) {
      slot.delete(registration.controllerId)
      if (slot.size === 0) windows.delete(registration.windowId)
    }
    if (windows && windows.size === 0) this.#registrations.delete(registration.peer)
    const set = this.#byPeer.get(registration.peer)
    if (set) {
      set.delete(registration)
      if (set.size === 0) this.#byPeer.delete(registration.peer)
    }
  }

  /** Revoca una registrazione: chiusa, sganciata, poll/pending rifiutati. */
  #revoke(registration, reason, now) {
    if (registration.closed) return
    registration.closed = true
    if (registration.expiryTimer !== null) this.#clearTimer(registration.expiryTimer)
    registration.expiryTimer = null
    this.#unlink(registration)

    if (registration.abortListener) {
      const signal = registration.peer.signal
      if (signal) signal.removeEventListener('abort', registration.abortListener)
      registration.abortListener = null
    }

    const poll = registration.poll
    registration.poll = null
    if (poll) poll.finish(new ControllerRegistryError('NOT_REGISTERED'))

    // Comandi non consegnati: rimossi in silenzio. Consegna at-most-once.
    const dropped = registration.queue.splice(0, registration.queue.length)
    for (const command of dropped) {
      const action = this.#actions.get(command.id)
      if (action) this.#cancel(action, 'ACTION_CANCELLED', now, true)
    }

    // Comandi consegnati: la Promise è già rifiutata; i risultati tardivi saranno
    // ignorati (azione settled) e non risolveranno nulla.
    for (const action of [...registration.delivered.values()]) {
      this.#cancel(action, 'ACTION_CANCELLED', now, true)
    }
    registration.delivered.clear()
    void reason
  }

  /** Preleva i comandi in coda e li marca consegnati (at-most-once). */
  #drain(registration, now) {
    if (registration.closed) return []
    const commands = registration.queue.splice(0, 16)
    for (const command of commands) {
      const action = this.#actions.get(command.id)
      if (!action) continue
      this.#markDelivered(action, now)
    }
    return commands
  }

  #markDelivered(action, now) {
    if (action.state !== 'queued') return
    action.state = 'delivered'
    action.callDelivered = true
    action.deliveredAt = now
    action.registration.delivered.set(action.id, action)
  }

  /** Risolve un'azione con il risultato del controller. */
  #settle(action, ok, payload, now) {
    if (action.state === 'settled') return
    action.state = 'settled'
    action.registration.delivered.delete(action.id)
    // A failure carries only a stable uppercase code; arbitrary page text never becomes an error code.
    // Only whitelisted client codes survive (with the static registry message); anything else collapses
    // to static ACTION_FAILED, so neither the raw code nor the raw message ever leaks.
    if (ok) this.#finish(action, 'ok', true, payload)
    else this.#finish(action, 'error', typeof payload === 'string' && CLIENT_ERROR_CODES.has(payload) ? payload : 'ACTION_FAILED')
    void now
  }

  /**
   * Cancella un'azione: se non consegnata la rimuove senza inviare nulla;
   * se consegnata invia {type:'cancel', id} al controller. Il risultato tardivo
   * non risolve perché l'azione è già settled.
   */
  #cancel(action, code, now, silent = false) {
    if (action.state === 'settled') return
    const wasDelivered = action.state === 'delivered'
    action.state = 'settled'
    action.registration.delivered.delete(action.id)
    if (!wasDelivered) action.registration.queue = action.registration.queue.filter(command => command.id !== action.id)
    this.#finish(action, 'error', code)
    if (wasDelivered && !silent && !action.registration.closed) {
      if (action.registration.queue.length >= this.#maxQueue) {
        this.#revoke(action.registration, 'cancel-overflow', now)
      } else {
        action.registration.queue.push({ type: 'cancel', id: action.id })
        const poll = action.registration.poll
        if (poll) poll.finish(null, { commands: this.#drain(action.registration, now), expiresAt: action.registration.expiresAt })
      }
    }
    void now
  }

  #finish(action, kind, payload, resultPayload) {
    this.#pending.delete(action)
    this.#actions.delete(action.id)
    if (action.cleanup) {
      action.cleanup()
      action.cleanup = null
    }
    const resolve = action.resolve
    const reject = action.reject
    action.resolve = null
    action.reject = null
    if (kind === 'ok') {
      if (payload === true) resolve?.(resultPayload)
      else reject?.(new ControllerRegistryError('ACTION_FAILED'))
      return
    }
    if (reject) reject(new ControllerRegistryError(payload))
  }
}

export default ControllerRegistry
export { KIND }
