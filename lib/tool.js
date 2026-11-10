// Host tool entry: the only public surface. Authority always comes from exec.agent and Host services.
import { operationHelp, validateArguments, runBatch, toolDefinition } from './ops.js'
import { formatResult } from './artifacts.js'

const MUTATIONS = new Set(['input.click','input.type','input.pointer','input.key','input.upload','js.eval','api.request','api.replay','ui.css','page.navigate','tab.open','tab.select','tab.close','tab.release'])
const fail = (code, message) => Object.assign(new Error(message), { code })
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0

/**
 * Only the Host handler for image.capture may produce image blocks. The array is copied into a frozen,
 * shape-checked form and never read from a Client/page result (`data.content`), so page text cannot spoof
 * an attachment. Structural checks keep the renderer from forwarding an arbitrary object as an image.
 */
function hostImageBlocks(value) {
  if (!Array.isArray(value?.content)) return undefined
  const blocks = []
  for (const block of value.content) {
    if (!block || block.type !== 'image' || !block.attachment || typeof block.attachment !== 'object') continue
    const attachment = block.attachment
    if (!ATTACHMENT_ID.test(attachment.attachmentId) || !IMAGE_MEDIA.has(attachment.mediaType) || !positive(attachment.bytes) || !positive(attachment.width) || !positive(attachment.height)) continue
    const copy = { attachmentId: attachment.attachmentId, mediaType: attachment.mediaType, bytes: attachment.bytes, width: attachment.width, height: attachment.height }
    if (typeof attachment.name === 'string' && attachment.name) copy.name = attachment.name.slice(0, 255)
    if (attachment.originalDimensions && positive(attachment.originalDimensions.width) && positive(attachment.originalDimensions.height)) copy.originalDimensions = Object.freeze({ width: attachment.originalDimensions.width, height: attachment.originalDimensions.height })
    blocks.push(Object.freeze({ type: 'image', attachment: Object.freeze(copy) }))
  }
  return blocks.length ? blocks : undefined
}

/** Build the tool definition. Nothing here reads page-provided authority; context is resolved per call. */
export function createBrowserTool({ registry, artifacts, resolveContext, handlers = {}, supportsImages = () => true, now = Date.now, maxResultBytes = 8192 }) {
  if (typeof resolveContext !== 'function') throw fail('CONFIGURATION', 'A Host context resolver is required.')
  // Result-object identity, not serializable content: only a result produced by the Host image handler in
  // this invocation can carry image blocks to the model.
  const hostImages = new WeakMap()
  const call = async (op, tab, args, exec) => {
    if (op === 'help') return operationHelp(args?.topic)
    if (op === 'batch') {
      if (!Array.isArray(args?.steps) || args.steps.length === 0 || args.steps.length > 32 || args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') throw fail('INVALID_ARGUMENT', 'batch needs 1–32 ordered steps and an optional boolean stopOnError.')
      const batch = await runBatch(args.steps, async (step, { signal }) => call(step.op, step.tab ?? tab, step.args, { ...exec, signal }), { stopOnError: args.stopOnError !== false, signal: exec.signal })
      return { ...batch, lastSucceeded: batch.lastSucceeded === null ? null : args.steps[batch.lastSucceeded] }
    }
    validateArguments(op, args)
    if (exec.signal?.aborted) throw fail('ABORTED', 'Browser operation cancelled before dispatch; an earlier site mutation may still finish.')
    const context = await resolveContext(exec)
    if (!context || typeof context.sessionId !== 'string' || typeof context.workspace !== 'string') throw fail('SESSION_CONTEXT', 'This tool requires a live DSH Session and workspace.')
    const handler = handlers[op]
    if (typeof handler === 'function') {
      const value = await handler({ op, tab, args, context, signal: exec.signal, exec })
      const result = formatResult({ context, value, store: artifacts, op, tabId: tab, now, maxBytes: maxResultBytes })
      if (op === 'image.capture') {
        const blocks = hostImageBlocks(value)
        if (blocks) hostImages.set(result, blocks)
      }
      return result
    }
    if (typeof op !== 'string' || !op.includes('.')) throw fail('UNKNOWN_OP', 'Unknown operation; call help.')
    // The registry signature is dispatch({ sessionId, workspace }, action, args, signal): passing the context
    // positionally made every call fail with a generic INVALID_FIELD instead of reaching the controller.
    const value = await registry.dispatch(context, op, { ...(tab ? { tabId: tab } : {}), ...(args ?? {}) }, exec.signal)
    return formatResult({ context, value, store: artifacts, op, tabId: tab, now, maxBytes: maxResultBytes })
  }
  // Every result keeps the same bounded textual envelope. Image blocks are appended only when the Host
  // handler for image.capture registered them for this exact result object; page-provided `content` arrays
  // (page.snapshot, js.eval, api.*) are never interpreted as attachments.
  const render = (_args, value) => {
    const text = [{ type: 'text', text: JSON.stringify(value) }]
    const blocks = value !== null && typeof value === 'object' ? hostImages.get(value) : undefined
    return blocks ? [...text, ...blocks] : text
  }
  const definition = toolDefinition(async (raw, exec) => {
    const args = isRecord(raw) ? raw : {}
    if (typeof args.op !== 'string' || !args.op.trim()) return { error: { code: 'INVALID_ARGUMENT', message: 'op is required; call browser with op "help".' } }
    if (args.tab !== undefined && (typeof args.tab !== 'string' || !args.tab.trim())) return { error: { code: 'INVALID_ARGUMENT', message: 'tab must be a nonempty tab id.' } }
    if (args.args !== undefined && !isRecord(args.args)) return { error: { code: 'INVALID_ARGUMENT', message: 'args must be an object.' } }
    try {
      return await call(args.op, args.tab, args.args, exec ?? {})
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'ACTION_FAILED'
      // Static, bounded failure: never echo page text, tokens or stack traces.
      return { error: { code, message: String(error?.message ?? 'Browser operation failed.').slice(0, 600) } }
    }
  })
  // toolDefinition only supplies a default JSON renderer; install the Host-image-aware closure here.
  definition.output.render = render
  return definition
}

/** Model-facing image route decision from the requested model's capability, not from page input. */
export function routeSupportsImages(modelSelection) {
  return modelSelection?.supportsImages === true || modelSelection?.capabilities?.images === true
}
export const MUTATING_OPERATIONS = MUTATIONS
