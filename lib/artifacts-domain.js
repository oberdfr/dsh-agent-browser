// DSH storage-domain declaration for the artifact index. `defineDomain`/`domainTable` are plain helpers
// exported by @deepseek-ai/dsh-storage-domain; the runtime contract is the spec object they return, so the
// spec is declared here directly and validated by the mounted DomainFacility when it is opened.
import { z } from 'zod'

const FIELDS = ['sessionId', 'workspace', 'mediaType', 'createdAt', 'pinned', 'bytes', 'sha256', 'storage', 'rootKey']
function recordSchema() {
  const base = z.object({
    sessionId: z.string().min(1).max(4096),
    workspace: z.string().min(1).max(4096),
    mediaType: z.enum(['application/json', 'text/plain']),
    createdAt: z.number().int().nonnegative(),
    pinned: z.boolean(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    storage: z.enum(['workspace', 'plugin-storage']),
    rootKey: z.string().max(4096).optional(),
    text: z.string().nullable()
  })
  return base.superRefine((value, context) => {
    if (value.storage === 'plugin-storage' && typeof value.text !== 'string') context.addIssue({ code: 'custom', message: 'plugin-storage records need inline text' })
    if (value.storage === 'workspace' && value.text !== null) context.addIssue({ code: 'custom', message: 'workspace records must not duplicate text' })
  })
}
/** The exact spec object accepted by `ctx.storageDomain.open()`. */
export function createArtifactDomain() {
  return Object.freeze({
    name: 'browser-dsh-artifacts',
    version: 1,
    layout: 'per-record',
    tables: Object.freeze({ artifacts: Object.freeze({ valueSchema: recordSchema() }) })
  })
}
export const ARTIFACT_DOMAIN_FIELDS = Object.freeze(FIELDS)
