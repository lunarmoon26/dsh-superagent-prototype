/** Synthetic ticket for the cross-repository DAL observation contract; no live workspace data. */
import type { Ticket } from '../../src/core/index.ts'

export function dalTicket(): Ticket {
  const at = '2026-11-03T12:00:00.000Z'
  return {
    id: 'ticket-fixture', title: 'Synthetic repair', decisionId: 'decision-fixture',
    mandate: { strength: 'explicit', policyVersion: 'fixture-policy', basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'github', id: 'fixture-person' }, scope: 'Synthetic scope' },
    origin: { triggerId: 'trigger-fixture', triggerIds: ['trigger-fixture'] },
    channels: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at,
    assignments: [{ id: 'assignment-first', state: 'ended', createdAt: at, startedAt: at, endedAt: at,
      report: { state: 'blocked', summary: 'Synthetic blocker', at } },
    { id: 'assignment-second', state: 'running', createdAt: at, startedAt: at,
      report: { state: 'ready', summary: 'Synthetic result', at }, idleAt: at }],
  }
}
