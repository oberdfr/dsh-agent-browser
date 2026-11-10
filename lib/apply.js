// Host activation: official transport, one tool, optional persistence. No WebSocket, companion or browser process.
import z from '@deepseek-ai/schemastery'
import { ControllerRegistry } from './controller-registry.js'
import { createBrowserTransport, createSessionResolver } from './transport.js'
import { ArtifactStore } from './artifacts.js'
import { ImageArtifacts } from './image-artifacts.js'
import { createBrowserTool, routeSupportsImages } from './tool.js'
import { createHostApiClient } from './api-client.js'
import { ArtifactPersistence } from './artifact-persistence.js'
import { createArtifactDomain } from './artifacts-domain.js'
import { decodePng, compareImages } from './image-diff.js'

// `attachments` is a hard dependency: the single tool owns screenshot storage and must not load without it.
// `fs` and `storageDomain` stay optional because artifact persistence is an explicit opt-in capability.
export const inject = ['tools', 'connection', 'sessions', 'workspaceRegistry', 'workingDirectory', 'agents', 'attachments']
export const Config = z.object({
  compatibilityTools: z.boolean().default(false).description('Re-register the previous 16 browser_* tools for older integrations. Off by default; saved history is never rewritten.'),
  maxResultBytes: z.number().step(1).min(1024).max(65536).default(8192).description('Default model-facing result budget in bytes (1024–65536).'),
  hostApiOrigins: z.array(z.string()).default([]).description('Explicit origins allowed for Host-mode api.request. Empty disables Host mode; loopback and DSH are always refused.')
})
const fail = (code, message) => Object.assign(new Error(message), { code })
const MAX_CAPTURE_BASE64 = 1_100_000
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Decode one bounded base64 capture. The transport owns the byte budget; this owns the shape. */
function decodeCapture(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CAPTURE_BASE64 || value.length % 4 !== 0 || !BASE64.test(value)) throw fail('CAPTURE_INVALID', 'The tab returned an invalid image payload.')
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    throw fail('CAPTURE_INVALID', 'The tab returned an invalid image payload.')
  }
}

export function apply(ctx, config = {}) {
  const maxResultBytes = config.maxResultBytes ?? 8192
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1024 || maxResultBytes > 65536) throw fail('CONFIGURATION', 'maxResultBytes must be an integer from 1024 to 65536.')
  const settings = {
    compatibilityTools: config.compatibilityTools === true,
    maxResultBytes,
    hostApiOrigins: Array.isArray(config.hostApiOrigins) ? config.hostApiOrigins : []
  }
  // Configuration is validated before any effect is installed: a rejected activation must leave no routes,
  // timers or per-Agent registrations behind.
  if (settings.compatibilityTools) throw fail('CONFIGURATION', 'compatibilityTools is not available in this build; the single browser tool remains active.')
  const registry = new ControllerRegistry()
  const store = new ArtifactStore()
  const baselines = new Map()
  const resolveSession = createSessionResolver({ sessions: ctx.sessions, workspaceRegistry: ctx.workspaceRegistry, workingDirectory: ctx.workingDirectory })
  const transport = createBrowserTransport({ connection: ctx.connection, registry, resolveSession })
  ctx.effect(() => () => { registry.close(); store.close() }, 'browser-dsh: registry and artifacts')
  ctx.effect(() => {
    const timer = setInterval(() => { try { store.cleanup() } catch {} }, 60 * 60 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'browser-dsh: artifact cleanup')
  ctx.effect(() => {
    let dispose
    let closed = false
    void transport.install().then(value => { if (closed) return value(); dispose = value }, () => {})
    return () => { closed = true; if (dispose) void dispose() }
  }, 'browser-dsh: exact authenticated transport routes')
  const resolveContext = async exec => {
    const agent = exec?.agent
    if (!agent?.id) throw fail('SESSION_CONTEXT', 'This tool requires a live DSH agent Session.')
    return resolveSession(agent.id, exec.signal)
  }
  const attachments = ctx.attachments ?? ctx.get?.('attachments')
  if (!attachments) throw fail('IMAGE_SERVICE', 'The Host attachment service is unavailable.')
  const images = new ImageArtifacts({ attachments })
  ctx.effect(() => () => images.close(), 'browser-dsh: image index')
  const hostApi = createHostApiClient({ allowedOrigins: settings.hostApiOrigins })
  let persistence
  let domain
  ctx.effect(() => () => {
    const current = persistence
    const open = domain
    persistence = undefined
    domain = undefined
    void (async () => { try { await current?.close?.() } finally { await open?.close?.() } })()
  }, 'browser-dsh: artifact persistence')
  const openPersistence = async () => {
    if (persistence) return persistence
    const fs = ctx.get?.('fs')
    const facility = ctx.get?.('storageDomain')
    if (!fs?.resolve || !fs?.writeText || !fs?.readBytes || !fs?.contains || !facility?.open) return null
    domain = await facility.open(createArtifactDomain())
    try {
      persistence = new ArtifactPersistence({ fs, table: domain.table('artifacts'), resolveDirectory: async context => (await resolveSession(context.sessionId)).directory })
    } catch (error) {
      await domain.close().catch(() => {})
      domain = undefined
      throw error
    }
    return persistence
  }
  // Image support is a property of the exact model route, not of page input or a guessed flag.
  const supportsImages = async exec => {
    let selection = exec?.modelSelection
    if (!selection) {
      try { selection = exec?.agent?.model?.current?.() } catch { selection = undefined }
    }
    if (!selection?.provider || !selection?.model) return false
    if (routeSupportsImages(selection)) return true
    const llm = ctx.get?.('llm')
    if (!llm?.resolveModelInfo) return false
    try {
      const info = await llm.resolveModelInfo(selection.provider, selection.model, exec?.signal)
      return info?.inputModalities?.includes('image') === true
    } catch {
      return false
    }
  }
  // One handler table for everything the Host, not the page, must own.
  const handlers = {
    'artifact.save': async ({ args, context }) => {
      const storage = await openPersistence()
      if (!storage) throw fail('PERSISTENCE_UNAVAILABLE', 'Persistent artifact storage is not available in this profile.')
      return storage.save(context, store.snapshot(context, args.artifactId))
    },
    'artifact.read': ({ args, context }) => store.read(context, args.artifactId, { offset: args.offset, maxBytes: args.maxBytes }),
    'artifact.search': ({ args, context }) => store.search(context, args.artifactId, { query: args.query, offset: args.offset, limit: args.limit }),
    'artifact.json': ({ args, context }) => store.json(context, args.artifactId, args.pointer),
    'artifact.list': ({ context }) => store.list(context),
    'artifact.pin': ({ args, context }) => store.pin(context, args.artifactId, args.pinned),
    'artifact.delete': ({ args, context }) => store.delete(context, args.artifactId),
    'api.request': async ({ args, context, signal, tab }) => {
      // Page mode is not a Host request: it must reach the exact Client controller, with the same tab binding
      // every other page operation uses. Host mode keeps its separate, explicitly authorized path.
      if (args.mode !== 'host') return registry.dispatch(context, 'api.request', { ...args, ...(tab ? { tabId: tab } : {}) }, signal)
      return hostApi({ method: args.method, url: args.url, headers: args.headers, body: args.body, signal })
    },
    'image.capture': async ({ args, context, signal, exec, tab }) => {
      const capture = await registry.dispatch(context, 'image.capture', { ...(args ?? {}), ...(tab ? { tabId: tab } : {}) }, signal)
      const saveOne = async tile => {
        if (!tile?.base64) throw fail('CAPTURE_FAILED', 'The tab returned no image.')
        const bytes = decodeCapture(tile.base64)
        const mediaType = tile.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
        return images.save(context, { data: bytes, mediaType }, signal)
      }
      const supports = await supportsImages(exec)
      if (Array.isArray(capture?.tiles)) {
        const tiles = []
        for (const tile of capture.tiles) tiles.push(await saveOne(tile))
        const content = tiles.length ? images.render(context, tiles[0].artifactId, { supportsImages: supports }) : undefined
        return { tiles, reconstructed: true, atomic: false, note: capture.note, ...(content ? { content } : {}) }
      }
      const saved = await saveOne(capture)
      const content = images.render(context, saved.artifactId, { supportsImages: supports })
      return { ...saved, reconstructed: capture.reconstructed === true, ...(capture.note ? { note: capture.note } : {}), content }
    },
    'image.compare': async ({ args, context, signal, tab }) => {
      // Baselines are isolated by Session, workspace, tab and name: the same name on another tab or
      // workspace must never compare against, or overwrite, this baseline.
      const key = `${context.sessionId}:${context.workspace}:${tab ?? ''}:${args.baseline ?? 'default'}`
      // PNG is required by the Host pixel decoder, so the Client is asked for that format explicitly.
      const current = await registry.dispatch(context, 'image.capture', { target: 'viewport', format: 'png', ...(tab ? { tabId: tab } : {}) }, signal)
      if (!current?.base64) throw fail('CAPTURE_FAILED', 'The tab returned no image.')
      const decoded = decodePng(decodeCapture(current.base64))
      if (args.updateBaseline === true) { baselines.set(key, decoded); return { baseline: args.baseline ?? 'default', updated: true, note: 'Baseline updated only on explicit request.' } }
      const baseline = baselines.get(key)
      if (!baseline) return { baseline: args.baseline ?? 'default', compared: false, note: 'No stored baseline for this key; capture one with updateBaseline: true.' }
      return { baseline: args.baseline ?? 'default', compared: true, ...compareImages(baseline, decoded, { tolerance: args.tolerance ?? 0.02, channelTolerance: args.channelTolerance ?? 0, mask: Array.isArray(args.mask) ? args.mask : [] }) }
    }
  }
  const tool = createBrowserTool({ registry, artifacts: store, resolveContext, supportsImages, now: Date.now, handlers, maxResultBytes: settings.maxResultBytes })
  // The single tool is scoped to one Agent: the tool context is resolved from exec.agent and the Host
  // Session, never from page input. A global registration would let any Agent see a tool it cannot use.
  ctx.effect(() => {
    const disposers = []
    const bind = agent => {
      if (typeof agent?.ctx?.effect !== 'function') return
      disposers.push(agent.ctx.effect(() => agent.ctx.tools.register(tool), 'browser-dsh: single browser tool'))
    }
    for (const agent of ctx.agents?.list?.() ?? []) bind(agent)
    const off = ctx.on?.('agent/created', ({ agent }) => bind(agent))
    return () => {
      if (typeof off === 'function') off()
      for (const dispose of disposers.splice(0)) { try { dispose() } catch {} }
    }
  }, 'browser-dsh: session-scoped single tool')
  return { registry, store, images, transport, settings }
}
