const MASK = '[REDACTED]'
const LIMIT = '[TRUNCATED]'
const normalizeKey = key => String(key).replace(/[^a-z0-9]/gi, '').toLowerCase()
const DEFAULT_KEYS = ['authorization','proxyauthorization','cookie','setcookie','password','passwd','pwd','secret','clientsecret','token','accesstoken','refreshtoken','idtoken','apikey','credential','credentials','sessionid','sessionkey','csrftoken','xcsrftoken','xapikey']
export function createRedactor({ sensitiveFields = [], knownSecrets = [], maxDepth = 16, maxNodes = 20000, maxStringChars = 65536 } = {}) {
  const fields = new Set([...DEFAULT_KEYS, ...sensitiveFields.map(normalizeKey)])
  const secrets = knownSecrets.filter(value => typeof value === 'string' && value.length >= 4).sort((a,b) => b.length - a.length)
  const sensitive = key => fields.has(normalizeKey(key)) || /(?:password|secret|token|apikey)$/.test(normalizeKey(key))
  const maskString = input => {
    let text = String(input)
    for (const secret of secrets) text = text.split(secret).join(MASK)
    // Header-like text and common credential formats; not a promise to detect arbitrary secrets.
    text = text.replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, `$1 ${MASK}`)
      .replace(/\b((?:proxy-)?authorization|set-cookie|cookie)\s*:\s*[^\r\n]*/gi, `$1: ${MASK}`)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, MASK)
      .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
        try {
          const url = new URL(raw)
          if (url.username) url.username = MASK
          if (url.password) url.password = MASK
          for (const key of [...url.searchParams.keys()]) if (sensitive(key)) url.searchParams.set(key, MASK)
          if (url.hash && /(?:token|password|secret|key|authorization)=/i.test(url.hash)) url.hash = MASK
          return url.href
        } catch { return raw }
      })
      .replace(/\b((?:access[_-]?|refresh[_-]?|id[_-]?)?token|api[_-]?key|password|client[_-]?secret)\s*([=:])\s*([^\s&;,"'<>]+)/gi, `$1$2${MASK}`)
    return text.length > maxStringChars ? `${text.slice(0, maxStringChars)}${LIMIT}` : text
  }
  return function redact(value) {
    let count = 0
    const seen = new WeakSet()
    const walk = (item, depth) => {
      if (++count > maxNodes || depth > maxDepth) return LIMIT
      if (item === null || typeof item === 'boolean') return item
      if (typeof item === 'number') return Number.isFinite(item) ? item : null
      if (typeof item === 'string') {
        const trimmed = item.trim()
        if (item.length <= maxStringChars && /^[{[]/.test(trimmed)) {
          try { return JSON.stringify(walk(JSON.parse(trimmed), depth + 1)) } catch {}
        }
        return maskString(item)
      }
      if (typeof item !== 'object') return `[UNSERIALIZABLE:${typeof item}]`
      if (seen.has(item)) return '[CIRCULAR]'
      seen.add(item)
      try {
        if (Array.isArray(item)) {
          const result = []
          for (let i = 0; i < item.length; i++) {
            if (count >= maxNodes) { result.push(LIMIT); break }
            const descriptor = Object.getOwnPropertyDescriptor(item, i)
            result.push(descriptor && 'value' in descriptor ? walk(descriptor.value, depth + 1) : '[ACCESSOR]')
          }
          return result
        }
        const entries = []
        for (const key of Object.keys(item)) {
          if (count >= maxNodes) { entries.push(['$truncated', true]); break }
          count++
          const descriptor = Object.getOwnPropertyDescriptor(item, key)
          // Never invoke page-controlled accessors/toJSON in privileged code.
          entries.push([maskString(key), sensitive(key) ? MASK : descriptor && 'value' in descriptor ? walk(descriptor.value, depth + 1) : '[ACCESSOR]'])
        }
        return Object.fromEntries(entries)
      } finally { seen.delete(item) }
    }
    return walk(value, 0)
  }
}
export const redact = createRedactor()
export const REDACTION_LIMITS = Object.freeze({ automaticDetectionIsNotASandbox: true, gaps: ['Unknown secrets in arbitrary text, image pixels and opaque binary are not reliably detectable.', 'Scripting retains page authority; redaction does not make arbitrary JS safe.'] })
