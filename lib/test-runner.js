// Declarative UI/API runner. Steps are validated locally; execution delegates to the Host dispatcher.
const runnerFail = (code, message) => Object.assign(new Error(message), { code })
const runnerRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const ASSERTION_KINDS = Object.freeze(['text', 'value', 'url', 'visible', 'hidden', 'geometry', 'overflow', 'style', 'api'])
export const MAX_STEPS = 64
export function validateStep(step, index) {
  if (!runnerRecord(step)) throw runnerFail('INVALID_STEP', `Step ${index} must be an object.`)
  const keys = Object.keys(step)
  if (keys.length !== 1) throw runnerFail('INVALID_STEP', `Step ${index} needs exactly one of action, wait, assert, proof or group.`)
  if (step.action !== undefined) {
    if (!runnerRecord(step.action) || typeof step.action.op !== 'string') throw runnerFail('INVALID_STEP', `Step ${index} action needs an op.`)
    return { kind: 'action', ...step.action }
  }
  if (step.wait !== undefined) {
    const wait = step.wait
    if (!runnerRecord(wait) || !['selector', 'request', 'time'].includes(wait.kind)) throw runnerFail('INVALID_STEP', `Step ${index} wait.kind must be selector, request or time.`)
    if (wait.kind === 'time' && (!Number.isFinite(wait.ms) || wait.ms < 0 || wait.ms > 15000)) throw runnerFail('INVALID_STEP', `Step ${index} wait.ms must be 0–15000.`)
    if (wait.kind === 'selector' && !runnerRecord(wait.locator)) throw runnerFail('INVALID_STEP', `Step ${index} wait.locator is required.`)
    if (wait.kind === 'request' && !runnerRecord(wait.match)) throw runnerFail('INVALID_STEP', `Step ${index} wait.match is required.`)
    return { ...wait, kind: 'wait', waitKind: wait.kind }
  }
  if (step.assert !== undefined) {
    const assertion = step.assert
    if (!runnerRecord(assertion) || !ASSERTION_KINDS.includes(assertion.kind)) throw runnerFail('INVALID_STEP', `Step ${index} assert.kind must be one of ${ASSERTION_KINDS.join(', ')}.`)
    // `selector` is the documented shorthand for a CSS locator. Normalize it here so execution never
    // keeps an unread field: an explicitly supplied locator and selector together are a conflict, not a
    // precedence choice, and an empty/non-string selector is invalid rather than silently ignored.
    if (assertion.selector !== undefined) {
      if (assertion.locator !== undefined) throw runnerFail('INVALID_STEP', `Step ${index} assert must use either locator or selector, not both.`)
      if (typeof assertion.selector !== 'string' || assertion.selector.trim() === '') throw runnerFail('INVALID_STEP', `Step ${index} assert.selector must be a non-empty CSS selector string.`)
    }
    const locator = assertion.locator !== undefined ? assertion.locator : assertion.selector !== undefined ? { css: assertion.selector } : undefined
    if (locator !== undefined) {
      if (!runnerRecord(locator)) throw runnerFail('INVALID_STEP', `Step ${index} assert.locator must be an object.`)
      if (typeof locator.css !== 'string' || locator.css.trim() === '') throw runnerFail('INVALID_STEP', `Step ${index} assert.locator.css must be a non-empty CSS selector string.`)
    }
    if (!['url', 'api'].includes(assertion.kind) && locator === undefined && assertion.kind !== 'text') throw runnerFail('INVALID_STEP', `Step ${index} assert.locator is required.`)
    if (assertion.kind === 'api' && !runnerRecord(assertion.match)) throw runnerFail('INVALID_STEP', `Step ${index} assert.match is required for API assertions.`)
    const normalized = { ...assertion, kind: 'assert', assertionKind: assertion.kind }
    delete normalized.selector
    if (locator !== undefined) normalized.locator = locator
    return normalized
  }
  if (step.proof !== undefined) {
    if (!runnerRecord(step.proof) || !['screenshot', 'snapshot', 'api'].includes(step.proof.kind)) throw runnerFail('INVALID_STEP', `Step ${index} proof.kind must be screenshot, snapshot or api.`)
    return { ...step.proof, kind: 'proof', proofKind: step.proof.kind }
  }
  if (step.group !== undefined) {
    if (!runnerRecord(step.group) || typeof step.group.name !== 'string' || !Array.isArray(step.group.steps) || step.group.steps.length === 0) throw runnerFail('INVALID_STEP', `Step ${index} group needs a name and steps.`)
    return { kind: 'group', name: step.group.name, steps: step.group.steps.map((child, at) => validateStep(child, `${index}.${at}`)) }
  }
  throw runnerFail('INVALID_STEP', `Step ${index} is not a recognized step.`)
}
export function validatePlan(steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw runnerFail('INVALID_ARGUMENT', 'test.run needs at least one step.')
  if (steps.length > MAX_STEPS) throw runnerFail('INVALID_ARGUMENT', `test.run accepts at most ${MAX_STEPS} top-level steps.`)
  return steps.map((step, index) => validateStep(step, index))
}
function compare(actual, expected, op = 'equals') {
  switch (op) {
    case 'equals': return actual === expected
    case 'contains': return typeof actual === 'string' && actual.includes(String(expected))
    case 'matches': return typeof actual === 'string' && typeof expected === 'string' && new RegExp(expected).test(actual)
    case 'gte': return typeof actual === 'number' && actual >= Number(expected)
    case 'lte': return typeof actual === 'number' && actual <= Number(expected)
    default: throw runnerFail('INVALID_STEP', `Unknown comparison "${op}".`)
  }
}
/** Pure assertion evaluation over already-observed values; never touches the page. */
export function evaluateAssertion(assertion, observed) {
  // A provided comparator implies its own comparison; an explicit op always wins.
  // contains is a text comparator; matches is a URL comparator; either may be used with the other kind.
  const implied = assertion.contains !== undefined ? 'contains' : assertion.matches !== undefined ? 'matches' : 'equals'
  const op = assertion.op ?? implied
  let actual
  if (assertion.kind === 'url') actual = observed?.url
  else if (assertion.kind === 'api') actual = observed?.api
  else if (assertion.kind === 'text') actual = observed?.text ?? observed?.value
  else if (assertion.kind === 'value') actual = observed?.value ?? observed?.text
  else if (assertion.kind === 'visible') actual = observed?.visible === true
  else if (assertion.kind === 'hidden') actual = observed?.visible === false
  else actual = observed?.[assertion.kind]
  const expected = assertion.expected ?? assertion.contains ?? assertion.matches ?? (assertion.kind === 'visible' || assertion.kind === 'hidden' ? true : undefined)
  return { pass: compare(actual, expected, op), kind: assertion.kind, op, actual: typeof actual === 'string' ? actual.slice(0, 500) : actual, expected: typeof expected === 'string' ? expected.slice(0, 500) : expected }
}
/** Execute a validated plan through the caller's dispatcher; stops at the first failed assertion by default. */
export async function runPlan(plan, execute, { stopOnError = true, signal } = {}) {
  const results = []
  const walk = async (steps, prefix) => {
    for (const [index, step] of steps.entries()) {
      signal?.throwIfAborted()
      const id = `${prefix}${index}`
      try {
        if (step.kind === 'group') { results.push({ id, kind: 'group', name: step.name }); await walk(step.steps, `${id}.`); continue }
        const value = await execute(step, { id, signal })
        if (step.kind === 'assert' && value?.pass === false) {
          results.push({ id, kind: 'assert', ok: false, ...value })
          if (stopOnError) return
          continue
        }
        results.push({ id, kind: step.kind, ok: true, value })
      } catch (error) {
        results.push({ id, kind: step.kind, ok: false, error: String(error?.code ?? 'STEP_FAILED') })
        if (stopOnError) return
      }
    }
  }
  await walk(plan, '')
  const failed = results.filter(result => result.ok === false)
  return { passed: failed.length === 0, results, failed: failed.length, total: results.filter(result => result.kind !== 'group').length, report: failed.length === 0 ? 'all steps passed' : `${failed.length} step(s) failed` }
}
export function imageDiff(before, after, { tolerance = 0.02, mask = [] } = {}) {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) throw runnerFail('INVALID_ARGUMENT', 'tolerance must be 0–1.')
  if (!runnerRecord(before) || !runnerRecord(after) || before.width !== after.width || before.height !== after.height) throw runnerFail('DIMENSION_MISMATCH', 'Images must share dimensions; resize or capture the same region.')
  const pixels = before.data ?? after.data
  if (!(pixels instanceof Uint8Array) || pixels.length !== before.width * before.height * 4) throw runnerFail('INVALID_ARGUMENT', 'RGBA pixel buffers are required.')
  let differing = 0
  for (let i = 0; i < before.width * before.height; i++) {
    const x = i % before.width, y = Math.floor(i / before.width)
    if (mask.some(rect => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height)) continue
    const a = i * 4
    if (before.data[a] !== after.data[a] || before.data[a + 1] !== after.data[a + 1] || before.data[a + 2] !== after.data[a + 2] || before.data[a + 3] !== after.data[a + 3]) differing++
  }
  const ratio = differing / (before.width * before.height)
  return { ratio, differing, pass: ratio <= tolerance, tolerance, maskedRegions: mask.length, updateBaseline: false, note: 'Baselines change only on an explicit choice.' }
}
