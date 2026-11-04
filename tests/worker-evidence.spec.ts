import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { ArtifactChecks, bindStrategy, evidenceSha256, MAX_ARTIFACT_BYTES, strategyPin, workerEvidenceView } from '../src/app/worker-evidence.ts'
import { KV } from '../src/kv.ts'
import { dalTicket } from './fixtures/dal.ts'
import { dalObservation } from '../src/app/dal.ts'

let dir: string, store: Store
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'worker-evidence-')); store = new Store(join(dir, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
const skills = [{ name: 'test-skill', content: 'literal skill', description: 'description' }]
function setup() {
  const ticket = dalTicket(), assignment = ticket.assignments.at(-1)!
  const pin = bindStrategy(store, ticket.id, assignment.id, 2, 'prompt', 'section', skills, true)
  const checks = new ArtifactChecks(store)
  const request = { assignment_id: assignment.id, generation_id: pin.generation_id,
    checks: [{ id: 'literal', kind: 'contains' as const, value: 'expected' }] }
  return { ticket, assignment, pin, checks, request }
}

it('creates no pin on preview and binds stable content once, surviving SQLite reopen', () => {
  const ticket = dalTicket(), assignment = ticket.assignments[0]!
  const preview = bindStrategy(store, ticket.id, assignment.id, 0, 'prompt', 'section', skills, false)
  expect(strategyPin(store, ticket.id, assignment.id)).toBeUndefined()
  const pin = bindStrategy(store, ticket.id, assignment.id, 0, 'prompt', 'section', skills, true)
  expect(pin.generation_id).toBe(preview.generation_id)
  expect(pin.context_sha256).toBe(evidenceSha256('section'))
  expect(pin.manifest.skills[0]).toEqual({ name: 'test-skill', content_sha256: evidenceSha256('literal skill'),
    description_sha256: evidenceSha256('description') })
  store.close(); store = new Store(join(dir, 'db.sqlite'))
  expect(bindStrategy(store, ticket.id, assignment.id, 0, 'prompt', 'section', skills, true)).toEqual(pin)
  expect(JSON.stringify(pin)).not.toContain('literal skill')
})

it.each(['revision', 'prompt', 'context', 'skill', 'description'] as const)('refuses %s drift without changing the pin', kind => {
  const { ticket, assignment, pin } = setup()
  const changed = skills.map(item => ({ ...item, ...(kind === 'skill' ? { content: 'changed' } : {}),
    ...(kind === 'description' ? { description: 'changed' } : {}) }))
  expect(() => bindStrategy(store, ticket.id, assignment.id, kind === 'revision' ? 3 : 2,
    kind === 'prompt' ? 'changed' : 'prompt', kind === 'context' ? 'changed' : 'section', changed, true)).toThrow('drifted')
  expect(strategyPin(store, ticket.id, assignment.id)).toEqual(pin)
  expect(bindStrategy(store, ticket.id, 'successor', 3, 'new prompt', 'new context', changed, true).generation_id).not.toBe(pin.generation_id)
})

it('freezes exactly one contract, verifies bytes, deduplicates receipts and stores no artifact bytes or filename', () => {
  const { ticket, pin, checks, request } = setup(), before = structuredClone(ticket)
  const observation = dalObservation(ticket, 'fixture-workspace')
  const artifact = 'expected private test contents'
  request.checks.push({ id: 'more', kind: 'contains', value: 'contents' })
  const contract = checks.contract(ticket, request)
  expect(checks.contract(ticket, request)).toEqual(contract)
  expect(() => checks.contract(ticket, { ...request, checks: [{ ...request.checks[0], value: 'other' }] })).toThrow('frozen')
  const input = { ...request, checks: undefined, contract_id: contract.id, artifact_base64: Buffer.from(artifact).toString('base64') }
  delete input.checks
  const receipt = checks.verify(ticket, input)
  expect(receipt).toMatchObject({ status: 'passed', artifact_sha256: evidenceSha256(artifact), artifact_bytes: Buffer.byteLength(artifact),
    generation_id: pin.generation_id, scope: 'supplied-artifact-only', results: [{ id: 'literal', pass: true }, { id: 'more', pass: true }] })
  expect(checks.verify(ticket, input)).toEqual(receipt)
  expect(workerEvidenceView(store, ticket).current?.receipts).toEqual([receipt])
  expect(JSON.stringify(store.get(KV.workerEvidence.receipts(ticket.id, request.assignment_id))))
    .not.toMatch(/private test|artifact_base64|filename/)
  expect(ticket).toEqual(before)
  expect(dalObservation(ticket, 'fixture-workspace')).toEqual(observation)
  expect(observation).toMatchObject({ verification: 'unverified', runtime_assurance: 'unattested', promotion_authority: 'none' })
})

it('handles exact hashes, exclusions, empty files and invalid UTF-8 without executing code', () => {
  const { ticket, checks, request } = setup()
  const bytes = Buffer.from([0xff, 0xfe])
  const contract = checks.contract(ticket, { ...request, checks: [
    { id: 'hash', kind: 'sha256', value: evidenceSha256(bytes) }, { id: 'exclude', kind: 'excludes', value: 'never' },
    { id: 'include', kind: 'contains', value: '$(touch should-not-run)' }] })
  const receipt = checks.verify(ticket, { assignment_id: request.assignment_id, generation_id: request.generation_id,
    contract_id: contract.id, artifact_base64: bytes.toString('base64') })
  expect(receipt).toMatchObject({ status: 'failed', results: [{ pass: true }, { pass: false }, { pass: false }] })
  const empty = checks.verify(ticket, { assignment_id: request.assignment_id, generation_id: request.generation_id,
    contract_id: contract.id, artifact_base64: '' })
  expect(empty).toMatchObject({ artifact_bytes: 0, results: [{ pass: false }, { pass: true }, { pass: false }] })
})

it('rejects stale assignments, missing pins and wrong strategy or contract bindings', () => {
  const { ticket, checks, request } = setup()
  expect(() => checks.contract(ticket, { ...request, assignment_id: 'old' })).toThrow('superseded')
  expect(() => checks.contract(ticket, { ...request, generation_id: `gen-${'0'.repeat(64)}` })).toThrow('binding')
  const contract = checks.contract(ticket, request)
  const input = { assignment_id: request.assignment_id, generation_id: request.generation_id, contract_id: contract.id, artifact_base64: '' }
  expect(() => checks.verify(ticket, { ...input, contract_id: `contract-${'0'.repeat(64)}` })).toThrow('contract')
  ticket.assignments.push({ ...ticket.assignments.at(-1)!, id: 'next-assignment' })
  expect(() => checks.verify(ticket, input)).toThrow('superseded')
  expect(() => checks.contract(ticket, { ...request, assignment_id: 'next-assignment' })).toThrow('binding')
  expect(workerEvidenceView(store, ticket)).toMatchObject({ current: { pin: null, contract: null, receipts: [] },
    history: [{ assignment_id: request.assignment_id, contract }, { assignment_id: 'assignment-first', pin: null }] })
})

it('bounds receipts but permits idempotent retry when the allocation is exhausted', () => {
  const { ticket, checks, request } = setup(), contract = checks.contract(ticket, request)
  const input = { assignment_id: request.assignment_id, generation_id: request.generation_id, contract_id: contract.id, artifact_base64: '' }
  const first = checks.verify(ticket, input)
  for (let index = 1; index < 20; index++) checks.verify(ticket, { ...input, artifact_base64: Buffer.from(String(index)).toString('base64') })
  expect(() => checks.verify(ticket, { ...input, artifact_base64: Buffer.from('overflow').toString('base64') })).toThrow('exhausted')
  expect(checks.verify(ticket, input)).toEqual(first)
  expect(workerEvidenceView(store, ticket).current?.receipts).toHaveLength(20)
})

it('shows a resupplied known artifact as current without duplicating or changing its immutable receipt', () => {
  const { ticket, checks, request } = setup(), contract = checks.contract(ticket, request)
  const input = { assignment_id: request.assignment_id, generation_id: request.generation_id,
    contract_id: contract.id, artifact_base64: Buffer.from('expected').toString('base64') }
  const passed = checks.verify(ticket, input)
  const failed = checks.verify(ticket, { ...input, artifact_base64: '' })
  expect(workerEvidenceView(store, ticket).current?.receipts.at(-1)).toEqual(failed)
  expect(checks.verify(ticket, input)).toEqual(passed)
  expect(workerEvidenceView(store, ticket).current?.receipts).toEqual([failed, passed])
  expect(checks.verify(ticket, input)).toEqual(passed)
  expect(workerEvidenceView(store, ticket).current?.receipts).toEqual([failed, passed])
})

it('rejects malformed checks, excessive allocations, noncanonical base64 and unknown upload fields', () => {
  const { ticket, checks, request } = setup()
  for (const bad of [[], [...request.checks, ...request.checks], Array(33).fill(request.checks[0]),
    [{ id: 'regex', kind: 'regex', value: '.*' }], [{ id: 'empty', kind: 'contains', value: '' }]]) {
    expect(() => checks.contract(ticket, { ...request, checks: bad })).toThrow()
  }
  const contract = checks.contract(ticket, request)
  const input = { assignment_id: request.assignment_id, generation_id: request.generation_id, contract_id: contract.id, artifact_base64: '' }
  for (const artifact_base64 of ['a', '!!!!', 'AB==', Buffer.alloc(MAX_ARTIFACT_BYTES + 1).toString('base64')]) {
    expect(() => checks.verify(ticket, { ...input, artifact_base64 })).toThrow()
  }
  expect(() => checks.verify(ticket, { ...input, filename: 'private-path' })).toThrow()
  expect(checks.verify(ticket, { ...input, artifact_base64: Buffer.alloc(MAX_ARTIFACT_BYTES).toString('base64') }).artifact_bytes).toBe(MAX_ARTIFACT_BYTES)
})

it.each(['strategy', 'contract', 'receipts'] as const)('rejects corrupted stored %s rather than showing success', family => {
  const { ticket, assignment, checks, request } = setup(), contract = checks.contract(ticket, request)
  checks.verify(ticket, { assignment_id: request.assignment_id, generation_id: request.generation_id,
    contract_id: contract.id, artifact_base64: '' })
  const key = KV.workerEvidence[family](ticket.id, assignment.id)
  const stored = store.get(key as string) as Record<string, unknown> | unknown[]
  if (Array.isArray(stored)) (stored[0] as Record<string, unknown>).status = 'passed'
  else if (family === 'strategy') stored.generation_id = `gen-${'0'.repeat(64)}`
  else stored.id = `contract-${'0'.repeat(64)}`
  store.set(key as string, stored)
  expect(() => workerEvidenceView(store, ticket)).toThrow('invalid')
})

it('rejects null receipts and orphaned evidence rather than treating them as an empty history', () => {
  const { ticket, assignment, pin, request, checks } = setup()
  store.set(KV.workerEvidence.receipts(ticket.id, assignment.id) as string, null)
  expect(() => workerEvidenceView(store, ticket)).toThrow('invalid')
  expect(() => checks.contract(ticket, request)).toThrow('invalid')
  const unknown = 'unbound-assignment'
  store.set(KV.workerEvidence.contract(ticket.id, unknown) as string, { generation_id: pin.generation_id })
  expect(() => bindStrategy(store, ticket.id, unknown, 2, 'prompt', 'section', skills, true)).toThrow('no strategy binding')
})
