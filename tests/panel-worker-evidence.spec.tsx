// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { bindStrategy, ArtifactChecks } from '../src/app/worker-evidence.ts'
import type { Ticket } from '../src/core/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { KV } from '../src/kv.ts'
import { server, evidenceStore } from './fixtures/panel-server.ts'
import { at, click, field, find, mount, remount, settle, text, type, usePanel } from './fixtures/panel.tsx'

usePanel()
function pinCurrent() {
  const ticket = server.ticketDetails.t1! as unknown as Ticket, assignment = ticket.assignments.at(-1)!
  const pin = bindStrategy(evidenceStore, ticket.id, assignment.id, 2, 'prompt', 'context', [], true)
  return { ticket, assignment, pin }
}
async function upload(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

it('keeps pre-pin assignments unknown, with no verification or contract writes', async () => {
  at({ page: 'execution', id: 't1' }); await mount(en)
  expect(text()).toContain(en.workerUnbound)
  expect(text()).toContain(en.dalUnverified)
  expect(text()).toContain(en.workerPinScope)
  expect(document.querySelector('input[type="file"]')).toBeNull()
  expect(server.requests.some(request => request.method !== 'GET')).toBe(false)
})

it('freezes an operator contract with confirmation, checks a file and retains whole-task uncertainty in both languages', async () => {
  const { pin, assignment, ticket } = pinCurrent()
  at({ page: 'execution', id: 't1' }); await mount(en)
  expect(text()).toContain(pin.generation_id)
  await type(field<HTMLInputElement>('Check 1 value'), 'expected')
  await click(en.artifactFreeze)
  expect(server.requests.some(request => request.method === 'PUT')).toBe(false)
  await click(en.confirm)
  expect(server.requests.filter(request => request.method === 'PUT')).toEqual([{ method: 'PUT', path: 'tickets/t1/artifact-contract',
    body: { assignment_id: assignment.id, generation_id: pin.generation_id,
      checks: [{ id: 'check-1', kind: 'contains', value: 'expected' }] } }])
  expect(text()).not.toContain(en.artifactAdd)
  await upload(new File(['expected secret artifact body'], 'private-filename.txt'))
  await click(en.artifactVerify)
  await settle()
  expect(text()).toContain(`${en.artifactResult}: ${en.artifactPassed}`)
  expect(text()).toContain(en.dalUnverified)
  expect(text()).toContain(en.dalUnattested)
  const request = server.requests.find(request => request.path.endsWith('/artifact-check'))!
  expect(JSON.stringify(request)).not.toContain('private-filename')
  expect(JSON.stringify(server.evidence.get(KV.workerEvidence.receipts(ticket.id, assignment.id)))).not.toContain('secret artifact body')
  await remount(zh)
  expect(text()).toContain(`${zh.artifactResult}: ${zh.artifactPassed}`)
  expect(text()).toContain(zh.dalUnverified)
  expect(text()).toContain(zh.artifactScope)
})

it('separates historical passes from a new Assignment and never exposes editing on historical evidence', async () => {
  const { ticket, pin, assignment } = pinCurrent(), checks = new ArtifactChecks(evidenceStore)
  const contract = checks.contract(ticket, { assignment_id: assignment.id, generation_id: pin.generation_id,
    checks: [{ id: 'first', kind: 'contains', value: 'yes' }] })
  checks.verify(ticket, { assignment_id: assignment.id, generation_id: pin.generation_id, contract_id: contract.id,
    artifact_base64: Buffer.from('yes').toString('base64') })
  ticket.assignments.push({ ...assignment, id: 'successor' })
  at({ page: 'execution', id: 't1' }); await mount(en)
  expect(document.querySelector('.dt-worker-evidence > p')?.textContent).toContain(en.workerPinScope)
  expect(text()).toContain(en.workerUnbound)
  expect(text()).toContain(en.workerHistory)
  expect(text()).toContain(`${en.artifactResult}: ${en.artifactUnchecked}`)
  expect(text()).toContain(`${en.artifactResult}: ${en.artifactPassed}`)
  expect(document.querySelector('input[type="file"]')).toBeNull()
  expect(text()).not.toContain(en.artifactFreeze)
})

it('refuses oversized uploads locally and reports stale Assignment rejection without changing ticket actions', async () => {
  const { ticket, assignment, pin } = pinCurrent()
  new ArtifactChecks(evidenceStore).contract(ticket, { assignment_id: assignment.id, generation_id: pin.generation_id,
    checks: [{ id: 'required', kind: 'contains', value: 'yes' }] })
  at({ page: 'execution', id: 't1' }); await mount(en)
  await upload(new File([new Uint8Array(1024 * 1024 + 1)], 'huge'))
  expect(text()).toContain(en.artifactTooLarge)
  expect((find(en.artifactVerify) as HTMLButtonElement).disabled).toBe(true)
  expect(server.requests.some(request => request.path.endsWith('/artifact-check'))).toBe(false)
  await upload(new File(['yes'], 'input'))
  ticket.assignments.push({ ...assignment, id: 'next' })
  await click(en.artifactVerify)
  expect(text()).toContain('Assignment was superseded')
  expect(text()).toContain(en.dalUnverified)
  await click(en.stop); await click(en.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toBe(true)
})

it('hides successful old data on evidence read failure instead of showing it as current success', async () => {
  const { assignment, ticket } = pinCurrent()
  server.evidence.set(KV.workerEvidence.receipts(ticket.id, assignment.id), [{ status: 'passed' }])
  at({ page: 'execution', id: 't1' }); await mount(en)
  expect(text()).toContain('Stored artifact receipts are invalid')
  expect(text()).not.toContain(`${en.artifactResult}: ${en.artifactPassed}`)
  expect(text()).toContain(en.dalUnverified)
})
