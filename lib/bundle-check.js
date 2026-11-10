// Static preflight for the generated Client bundle: it must keep the preserved UI and must not reintroduce
// any execution path this project removed (custom WebSocket, companion, cookie sniffing, direct Host fetch).
const REQUIRED = [
  { code: 'BUNDLE_SLOT', pattern: /sidebar\.right\.pane\.tab/ },
  { code: 'BUNDLE_CONNECTION', pattern: /createControllerTransport/ },
  { code: 'BUNDLE_TABS', pattern: /class BrowserTabs/ },
  { code: 'BUNDLE_OPERATIONS', pattern: /createPageOperations/ },
  { code: 'BUNDLE_SPA', pattern: /createSpaTracker/ },
  { code: 'BUNDLE_DRAWER', pattern: /function drawerView/ },
  { code: 'BUNDLE_CSS_SCOPE', pattern: /\.ocb-root\s/ },
  { code: 'BUNDLE_ANNOTATION', pattern: /annotationOverlay/ }
]
const FORBIDDEN = ['/browser-use/ws', 'connectBrowserSocket', 'browserWebSocketUrl', 'browserCompanion', 'rpcQueue', 'dsh-auth-', 'cookieMaxAge', 'client-connection/browser-session']
// A `/` can only start a regex literal after an operator, an opening bracket or one of these keywords.
// The heuristic is deliberately conservative: when in doubt the slash is kept as division, so regex
// handling can never erase executable code from the scan.
const REGEX_PREFIX = new Set('(,=:[!&|?{};+-*%^~<>'.split(''))
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])
function regexAllowed(out) {
  const trimmed = out.replace(/\s+$/, '')
  if (trimmed.length === 0) return true
  if (REGEX_PREFIX.has(trimmed[trimmed.length - 1])) return true
  const word = /([A-Za-z_$][\w$]*)$/.exec(trimmed)
  return word !== null && REGEX_KEYWORDS.has(word[1])
}
/** Skip a regex literal starting at `start`; return the index after it, or null when it is not closed on this line. */
function skipRegex(code, start) {
  let index = start + 1, inClass = false
  while (index < code.length) {
    const char = code[index]
    if (char === '\n') return null
    if (char === '\\') { index += 2; continue }
    if (char === '[') { inClass = true; index++; continue }
    if (char === ']') { inClass = false; index++; continue }
    if (char === '/' && !inClass) {
      index++
      while (index < code.length && /[a-z]/i.test(code[index])) index++
      return index
    }
    index++
  }
  return null
}
/** Skip a quoted string starting at `start`; return the index after the closing quote. */
function skipString(code, start) {
  const quote = code[start]
  let index = start + 1
  while (index < code.length) {
    if (code[index] === '\\') { index += 2; continue }
    if (code[index] === quote) return index + 1
    index++
  }
  return index
}
/**
 * Scan a template literal starting at `start` (a backtick). Literal text is removed, but every `${...}`
 * expression is scanned as code, recursively: nested templates, braces, strings and comments inside an
 * interpolation stay balanced and executable calls inside it remain visible. Newlines are preserved.
 */
function scanTemplate(code, start) {
  let out = ' '
  let index = start + 1
  while (index < code.length) {
    const char = code[index]
    if (char === '\\') { index += 2; continue }
    if (char === '`') return { out: out + ' ', index: index + 1 }
    if (char === '$' && code[index + 1] === '{') {
      const nested = scan(code, index + 2, true)
      out += '${' + nested.out + '}'
      index = nested.index
      continue
    }
    if (char === '\n') out += '\n'
    index++
  }
  return { out, index }
}
/**
 * Remove comments and string/template literal text before checking executable boundaries, while keeping
 * every template interpolation as code. This is deliberately a small lexer, not a regex: a `//` or `/*`
 * inside a string must not hide an `import`, and a `fetch(` inside a page-script template literal must not
 * be mistaken for executable code — but `${fetch(...)}` must be.
 */
function scan(code, start, inExpression) {
  let out = ''
  let index = start
  let depth = 0
  while (index < code.length) {
    const char = code[index], next = code[index + 1]
    if (char === '/' && next === '/') {
      index += 2
      while (index < code.length && code[index] !== '\n') index++
      if (index < code.length) { out += '\n'; index++ }
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) {
        if (code[index] === '\n') out += '\n'
        index++
      }
      index = Math.min(code.length, index + 2)
      out += ' '
      continue
    }
    if (char === '"' || char === "'") { index = skipString(code, index); out += ' '; continue }
    if (char === '`') { const template = scanTemplate(code, index); out += template.out; index = template.index; continue }
    if (char === '/' && regexAllowed(out)) {
      const end = skipRegex(code, index)
      if (end !== null) { out += ' '; index = end; continue }
    }
    if (inExpression) {
      if (char === '{') depth++
      else if (char === '}') {
        if (depth === 0) return { out, index: index + 1 }
        depth--
      }
    }
    out += char
    index++
  }
  return { out, index }
}
export function stripCode(code) {
  return scan(code, 0, false).out
}
/** Check a generated bundle; returns the problems found, empty when the bundle is acceptable. */
export function preflightBundle(code) {
  if (typeof code !== 'string' || code.length === 0) return { ok: false, problems: [{ code: 'BUNDLE_EMPTY' }], required: REQUIRED.length, forbidden: FORBIDDEN.length }
  const problems = []
  for (const { code: marker, pattern } of REQUIRED) if (!pattern.test(code)) problems.push({ code: 'BUNDLE_MISSING_MARKER', marker })
  for (const marker of FORBIDDEN) if (code.includes(marker)) problems.push({ code: 'BUNDLE_FORBIDDEN_DEPENDENCY', markers: [marker] })
  const loaderCalls = (code.match(/__ModuleLoader__\.load\(/g) ?? []).length
  if (loaderCalls !== 1) problems.push({ code: 'BUNDLE_LOADER_COUNT', count: loaderCalls })
  const executable = stripCode(code)
  // No module statement may survive in an inlined script, even after a string or a comment on the same line.
  if (/\b(?:import|export)\b/.test(executable)) problems.push({ code: 'BUNDLE_MODULE_STATEMENT' })
  // The only executable fetch is the injected `fetchImpl`; page-context fetch lives inside a template string.
  const fetchSites = [...executable.matchAll(/\bfetch\s*\(/g)]
  if (fetchSites.length) problems.push({ code: 'BUNDLE_DIRECT_FETCH', sites: fetchSites.length })
  return { ok: problems.length === 0, problems, required: REQUIRED.length, forbidden: FORBIDDEN.length }
}
export const BUNDLE_MARKERS = Object.freeze({ required: REQUIRED.map(entry => entry.code), forbidden: FORBIDDEN })
