// SPA/HMR awareness: a document generation changes on navigation and on in-page route changes. The observer
// attaches once per document, and a new generation invalidates references and pending waits of the old one.
const spaFail = (code, message) => Object.assign(new Error(message), { code })
export const SPA_EVENTS = Object.freeze(['did-navigate', 'did-navigate-in-page', 'dom-ready', 'render-process-gone'])
/** Track document generations from webview events; returns the current generation and a listener factory. */
export function createSpaTracker({ onGeneration = () => {}, onRestore = () => {} } = {}) {
  let generation = 0
  let documentId = null
  let url = null
  const listeners = new Map()
  const bump = (reason, nextUrl) => {
    // dom-ready for the document already tracked is the same generation; a missing URL keeps the current one.
    if (reason === 'dom-ready' && documentId !== null && (nextUrl === undefined || nextUrl === url)) return { generation, documentId, reused: true }
    generation++
    documentId = `doc-${generation}`
    url = nextUrl ?? url
    onGeneration({ generation, documentId, url, reason })
    return { generation, documentId, reused: false }
  }
  return {
    attach(webview) {
      if (!webview?.addEventListener) throw spaFail('INVALID_ARGUMENT', 'A webview with addEventListener is required.')
      for (const event of SPA_EVENTS) {
        const listener = payload => {
          if (event === 'render-process-gone') onRestore({ generation, documentId, reason: 'render-process-gone' })
          bump(event, event.startsWith('did-navigate') ? payload?.url : undefined)
        }
        webview.addEventListener(event, listener)
        listeners.set(event, listener)
      }
      bump('attach')
      return () => {
        for (const [event, listener] of listeners) webview.removeEventListener?.(event, listener)
        listeners.clear()
      }
    },
    current: () => ({ generation, documentId, url }),
    /** A reference or wait created for another document generation is stale, never silently reused. */
    assertCurrent(expected) {
      if (expected?.documentId !== undefined && expected.documentId !== documentId) throw spaFail('STALE_DOCUMENT', 'The page document changed; references and pending waits are invalid.')
      if (expected?.generation !== undefined && expected.generation !== generation) throw spaFail('STALE_DOCUMENT', 'The page document changed; references and pending waits are invalid.')
      return true
    }
  }
}
/** HMR/SPA re-render can replace nodes: a reference must be re-resolved, not assumed to point at the same element. */
export function referenceValid(reference, current) {
  if (!reference || typeof reference !== 'object') return false
  if (reference.documentId !== current?.documentId) return false
  if (typeof reference.selector !== 'string' || !reference.selector) return false
  return true
}
export const SPA_POLICY = Object.freeze({ generationPerDocument: true, referencesInvalidatedOnNavigation: true, observerReattachedOnce: true, frameworkInternalsNotExposed: true })
