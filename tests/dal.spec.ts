import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { dalObservation } from '../src/app/dal.ts'
import type { Ticket } from '../src/core/index.ts'
import { dalTicket } from './fixtures/dal.ts'

it('exports a deterministic metadata-only snapshot without changing the ticket', () => {
  const ticket = dalTicket(), before = structuredClone(ticket)
  ticket.title = 'private-title'
  ticket.mandate.actor.id = 'private-actor'
  ticket.mandate.scope = 'private-scope'
  ticket.assignments[0]!.report!.summary = 'private-report'
  const exported = dalObservation(ticket, 'fixture-workspace')
  expect(exported).toEqual(dalObservation(ticket, 'fixture-workspace'))
  expect(exported).toEqual(dalObservation(before, 'fixture-workspace'))
  expect(JSON.stringify(exported)).not.toMatch(/private-|ticket-fixture|assignment-first|fixture-workspace|worker-ticket/)
  expect(ticket.assignments).toHaveLength(2)
  expect(before).toEqual(dalTicket())
  expect(new Set(exported.assignments.map(item => item.assignment_sha256)).size).toBe(2)
  expect(exported).toMatchObject({ verification: 'unverified', runtime_assurance: 'unattested', promotion_authority: 'none' })
})

it('matches the portable golden export consumed by DAL', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/dal-observation.json', import.meta.url), 'utf8'))
  expect(dalObservation(dalTicket(), 'fixture-workspace')).toEqual(golden)
})

it.each(['completed', 'merged', 'closed', 'stopped', 'dropped'] as const)('does not turn %s into verified success', outcome => {
  const ticket = dalTicket()
  ticket.ended = { by: 'human', outcome, at: ticket.updatedAt }
  expect(dalObservation(ticket, 'fixture-workspace')).toMatchObject({ ticket_state: outcome,
    verification: 'unverified', runtime_assurance: 'unattested', promotion_authority: 'none' })
})

it.each(['ready', 'failed', 'blocked', 'waiting', 'progress', 'dropped'] as const)('keeps the %s report separate from verification', state => {
  const ticket = dalTicket()
  ticket.assignments[1]!.report!.state = state
  expect(dalObservation(ticket, 'fixture-workspace')).toMatchObject({ verification: 'unverified',
    assignments: [{ report_state: 'blocked' }, { report_state: state }] })
})

it('namespaces identities and changes identity only when projected metadata changes', () => {
  const ticket = dalTicket(), initial = dalObservation(ticket, 'workspace-one')
  expect(dalObservation(ticket, 'workspace-two').ticket_sha256).not.toBe(initial.ticket_sha256)
  ticket.assignments[1]!.report!.state = 'failed'
  expect(dalObservation(ticket, 'workspace-one').observation_id).not.toBe(initial.observation_id)
})

it('rejects malformed metadata rather than exporting arbitrary values', () => {
  const ticket = dalTicket()
  ticket.updatedAt = 'private-invalid-date'
  expect(() => dalObservation(ticket, 'workspace')).toThrow('invalid timestamp')
  ticket.updatedAt = '2026-11-03T12:00:00.000Z'
  ticket.assignments[0]!.state = 'private-state' as Ticket['assignments'][number]['state']
  expect(() => dalObservation(ticket, 'workspace')).toThrow('unsupported lifecycle state')
  ticket.assignments = [dalTicket().assignments[0]!, dalTicket().assignments[0]!]
  expect(() => dalObservation(ticket, 'workspace')).toThrow('repeats an assignment')
  ticket.assignments = Array.from({ length: 1001 }, () => dalTicket().assignments[0]!)
  expect(() => dalObservation(ticket, 'workspace')).toThrow('assignment limit')
})
