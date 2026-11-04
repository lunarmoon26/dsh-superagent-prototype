/** Assignment-scoped prompt/skill pins and host-computed checks of operator-supplied artifact bytes. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/)
const time = z.iso.datetime()
const generationId = z.string().regex(/^gen-[a-f0-9]{64}$/)
export const MAX_ARTIFACT_BYTES = 1024 * 1024
const MAX_RECEIPTS = 20

/** A deliberately partial generation: no model, inherited instructions, tools or runtime attestation. */
export const StrategyManifestSchema = z.object({
  scope: z.literal('superagent-prompt-skills-v1'),
  prompt_revision: z.number().int().nonnegative(),
  prompt_sha256: digest,
  skills: z.array(z.object({ name: identity, content_sha256: digest, description_sha256: digest }).strict()).max(1000),
}).strict()
export const StrategyPinSchema = z.object({
  ticket_id: identity, assignment_id: identity, generation_id: generationId,
  manifest: StrategyManifestSchema, context_sha256: digest, bound_at: time,
}).strict()
export type StrategyPin = z.infer<typeof StrategyPinSchema>

export const ArtifactCheckSchema = z.discriminatedUnion('kind', [
  z.object({ id: identity, kind: z.literal('contains'), value: z.string().min(1).max(1024) }).strict(),
  z.object({ id: identity, kind: z.literal('excludes'), value: z.string().min(1).max(1024) }).strict(),
  z.object({ id: identity, kind: z.literal('sha256'), value: digest }).strict(),
])
export const ArtifactContractInputSchema = z.object({ assignment_id: identity, generation_id: generationId,
  checks: z.array(ArtifactCheckSchema).min(1).max(32) }).strict()
export const ArtifactContractSchema = ArtifactContractInputSchema.extend({
  id: z.string().regex(/^contract-[a-f0-9]{64}$/), ticket_id: identity, context_sha256: digest,
}).strict()
export type ArtifactContract = z.infer<typeof ArtifactContractSchema>
export const ArtifactReceiptSchema = z.object({
  id: z.string().regex(/^check-[a-f0-9]{64}$/), ticket_id: identity, assignment_id: identity,
  generation_id: generationId, context_sha256: digest, contract_id: z.string().regex(/^contract-[a-f0-9]{64}$/),
  verifier: z.literal('literal-artifact-v1'), scope: z.literal('supplied-artifact-only'),
  artifact_sha256: digest, artifact_bytes: z.number().int().min(0).max(MAX_ARTIFACT_BYTES),
  results: z.array(z.object({ id: identity, pass: z.boolean() }).strict()).min(1).max(32),
  status: z.enum(['passed', 'failed']), checked_at: time,
}).strict()
export type ArtifactReceipt = z.infer<typeof ArtifactReceiptSchema>
export const ArtifactUploadSchema = z.object({ assignment_id: identity, generation_id: generationId,
  contract_id: z.string().regex(/^contract-[a-f0-9]{64}$/),
  artifact_base64: z.string().max(4 * Math.ceil(MAX_ARTIFACT_BYTES / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict()

/** A bounded evidence refusal; callers receive no artifact content or unchecked stored values. */
export class WorkerEvidenceError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 409) { super(message) }
}
export const evidenceSha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  return JSON.stringify(value)
}
const contentId = (prefix: string, value: unknown) => `${prefix}-${evidenceSha256(canonical(value))}`
type PinStore = Pick<Store, 'get' | 'set'>
type EvidenceStore = Pick<Store, 'get' | 'set' | 'atomic'>

export function strategyPin(store: Pick<Store, 'get'>, ticketId: string, assignmentId: string): StrategyPin | undefined {
  const value = store.get(KV.workerEvidence.strategy(ticketId, assignmentId))
  if (value === undefined) return undefined
  const parsed = StrategyPinSchema.safeParse(value)
  if (!parsed.success || parsed.data.ticket_id !== ticketId || parsed.data.assignment_id !== assignmentId
    || parsed.data.generation_id !== contentId('gen', parsed.data.manifest)
    || new Set(parsed.data.manifest.skills.map(item => item.name)).size !== parsed.data.manifest.skills.length) {
    throw new WorkerEvidenceError('Stored worker strategy evidence is invalid')
  }
  return parsed.data
}

/** Verify an existing pin or bind exactly once on actual request assembly, never on a preview. */
export function bindStrategy(store: PinStore, ticketId: string, assignmentId: string, revision: number,
  prompt: string, section: string, skills: { name: string; content: string; description: string }[], persist: boolean): StrategyPin {
  const manifest = StrategyManifestSchema.parse({ scope: 'superagent-prompt-skills-v1', prompt_revision: revision,
    prompt_sha256: evidenceSha256(prompt), skills: skills.map(item => ({ name: item.name,
      content_sha256: evidenceSha256(item.content), description_sha256: evidenceSha256(item.description) })) })
  if (new Set(manifest.skills.map(item => item.name)).size !== manifest.skills.length) throw new WorkerEvidenceError('Worker skill identities repeat')
  const generation = contentId('gen', manifest), context = evidenceSha256(section)
  const previous = strategyPin(store, ticketId, assignmentId)
  if (previous) {
    if (previous.generation_id !== generation || previous.context_sha256 !== context) {
      throw new WorkerEvidenceError('Worker strategy or context drifted; start a new authorized Assignment')
    }
    return previous
  }
  if (store.get(KV.workerEvidence.contract(ticketId, assignmentId)) !== undefined
    || store.get(KV.workerEvidence.receipts(ticketId, assignmentId)) !== undefined) throw new WorkerEvidenceError('Artifact evidence has no strategy binding')
  const pin = StrategyPinSchema.parse({ ticket_id: ticketId, assignment_id: assignmentId, generation_id: generation,
    manifest, context_sha256: context, bound_at: new Date().toISOString() })
  if (persist) store.set(KV.workerEvidence.strategy(ticketId, assignmentId), pin)
  return pin
}

function requireCurrent(store: Pick<Store, 'get'>, ticket: Ticket, assignmentId: string, generation: string): StrategyPin {
  if (ticket.assignments.at(-1)?.id !== assignmentId) throw new WorkerEvidenceError('Assignment was superseded; reload its evidence')
  const pin = strategyPin(store, ticket.id, assignmentId)
  if (!pin || pin.generation_id !== generation) throw new WorkerEvidenceError('Worker strategy binding is missing or changed')
  return pin
}
function contractOf(store: Pick<Store, 'get'>, pin: StrategyPin): ArtifactContract | undefined {
  const stored = store.get(KV.workerEvidence.contract(pin.ticket_id, pin.assignment_id))
  if (stored === undefined) return undefined
  const parsed = ArtifactContractSchema.safeParse(stored)
  if (!parsed.success) throw new WorkerEvidenceError('Stored artifact contract is invalid')
  const { id, ...payload } = parsed.data
  if (id !== contentId('contract', payload) || payload.ticket_id !== pin.ticket_id || payload.assignment_id !== pin.assignment_id
    || payload.generation_id !== pin.generation_id || payload.context_sha256 !== pin.context_sha256
    || new Set(payload.checks.map(item => item.id)).size !== payload.checks.length) {
    throw new WorkerEvidenceError('Stored artifact contract binding is invalid')
  }
  return parsed.data
}
function receiptsOf(store: Pick<Store, 'get'>, pin: StrategyPin, contract: ArtifactContract | undefined): ArtifactReceipt[] {
  const stored = store.get(KV.workerEvidence.receipts(pin.ticket_id, pin.assignment_id))
  const parsed = z.array(ArtifactReceiptSchema).max(MAX_RECEIPTS).safeParse(stored === undefined ? [] : stored)
  if (!parsed.success) throw new WorkerEvidenceError('Stored artifact receipts are invalid')
  const receipts = parsed.data
  if (new Set(receipts.map(item => item.id)).size !== receipts.length) throw new WorkerEvidenceError('Stored artifact receipt identity repeats')
  for (const receipt of receipts) {
    const { id, checked_at: _time, ...payload } = receipt
    if (!contract || id !== contentId('check', payload) || receipt.ticket_id !== pin.ticket_id || receipt.assignment_id !== pin.assignment_id
      || receipt.generation_id !== pin.generation_id || receipt.context_sha256 !== pin.context_sha256 || receipt.contract_id !== contract.id
      || receipt.status !== (receipt.results.every(item => item.pass) ? 'passed' : 'failed')
      || receipt.results.map(item => item.id).join('\0') !== contract.checks.map(item => item.id).join('\0')) {
      throw new WorkerEvidenceError('Stored artifact receipt binding is invalid')
    }
  }
  return receipts
}

/** Deterministic checks over supplied bytes, independent of worker self-reports but not proof of artifact provenance. */
export class ArtifactChecks {
  constructor(private readonly store: EvidenceStore) {}
  contract(ticket: Ticket, value: unknown): ArtifactContract {
    const input = ArtifactContractInputSchema.parse(value)
    if (new Set(input.checks.map(item => item.id)).size !== input.checks.length) throw new WorkerEvidenceError('Check identities must be unique', 400)
    return this.store.atomic(() => {
      const pin = requireCurrent(this.store, ticket, input.assignment_id, input.generation_id)
      const payload = { ...input, ticket_id: ticket.id, context_sha256: pin.context_sha256 }
      const contract = { ...payload, id: contentId('contract', payload) }
      const previous = contractOf(this.store, pin)
      receiptsOf(this.store, pin, previous)
      if (previous && previous.id !== contract.id) throw new WorkerEvidenceError('Artifact checks are frozen for this Assignment')
      if (!previous) this.store.set(KV.workerEvidence.contract(ticket.id, input.assignment_id), contract)
      return previous ?? contract
    })
  }
  verify(ticket: Ticket, value: unknown): ArtifactReceipt {
    const input = ArtifactUploadSchema.parse(value)
    const bytes = Buffer.from(input.artifact_base64, 'base64')
    if (bytes.length > MAX_ARTIFACT_BYTES || bytes.toString('base64') !== input.artifact_base64) throw new WorkerEvidenceError('Artifact encoding or size is invalid', 400)
    return this.store.atomic(() => {
      const pin = requireCurrent(this.store, ticket, input.assignment_id, input.generation_id)
      const contract = contractOf(this.store, pin)
      if (!contract || input.contract_id !== contract.id) throw new WorkerEvidenceError('Artifact contract is missing or changed')
      const artifactDigest = evidenceSha256(bytes)
      let text: string | undefined
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { /* Invalid UTF-8 fails text checks, not hash checks. */ }
      const results = contract.checks.map(check => ({ id: check.id,
        pass: check.kind === 'sha256' ? artifactDigest === check.value : text !== undefined
          && (check.kind === 'contains' ? text.includes(check.value) : !text.includes(check.value)) }))
      const payload = { ticket_id: ticket.id, assignment_id: input.assignment_id, generation_id: pin.generation_id,
        context_sha256: pin.context_sha256, contract_id: contract.id, verifier: 'literal-artifact-v1' as const,
        scope: 'supplied-artifact-only' as const, artifact_sha256: artifactDigest, artifact_bytes: bytes.length,
        results, status: results.every(item => item.pass) ? 'passed' as const : 'failed' as const }
      const id = contentId('check', payload), previous = receiptsOf(this.store, pin, contract)
      const existing = previous.find(item => item.id === id)
      if (existing) {
        // Keep immutable receipt identity/time, but show the most recently supplied artifact, not the last distinct one.
        if (previous.at(-1)?.id !== id) this.store.set(KV.workerEvidence.receipts(ticket.id, input.assignment_id),
          [...previous.filter(item => item.id !== id), existing])
        return existing
      }
      if (previous.length >= MAX_RECEIPTS) throw new WorkerEvidenceError('Artifact check allocation is exhausted for this Assignment')
      const receipt = ArtifactReceiptSchema.parse({ ...payload, id, checked_at: new Date().toISOString() })
      this.store.set(KV.workerEvidence.receipts(ticket.id, input.assignment_id), [...previous, receipt])
      return receipt
    })
  }
}

/** All evidence is explicitly attributed; superseded Assignment results never become the current result. */
export function workerEvidenceView(store: Pick<Store, 'get'>, ticket: Ticket) {
  const view = (assignmentId: string) => {
    const pin = strategyPin(store, ticket.id, assignmentId)
    if (!pin) {
      if (store.get(KV.workerEvidence.contract(ticket.id, assignmentId)) !== undefined
        || store.get(KV.workerEvidence.receipts(ticket.id, assignmentId)) !== undefined) throw new WorkerEvidenceError('Artifact evidence has no strategy binding')
      return { assignment_id: assignmentId, pin: null, contract: null, receipts: [] as ArtifactReceipt[] }
    }
    const contract = contractOf(store, pin)
    return { assignment_id: assignmentId, pin, contract: contract ?? null, receipts: receiptsOf(store, pin, contract) }
  }
  return { current: ticket.assignments.length ? view(ticket.assignments.at(-1)!.id) : null,
    history: ticket.assignments.slice(0, -1).reverse().map(item => view(item.id)) }
}
export type WorkerEvidenceView = ReturnType<typeof workerEvidenceView>
