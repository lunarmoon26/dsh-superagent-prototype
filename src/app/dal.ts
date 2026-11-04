/** Metadata-only DAL handoff. Exact external shape: DAL's superagent-observation.v1 schema. */
import { createHash } from 'node:crypto'
import type { Ticket } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const member = <T extends string>(value: T, allowed: readonly T[]): T => {
  if (!allowed.includes(value)) throw new Error('DAL observation contains an unsupported lifecycle state')
  return value
}
function time(value: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('DAL observation contains an invalid timestamp')
  const result = parsed.toISOString()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) throw new Error('DAL observation timestamp is out of range')
  return result
}
const optionalTime = (value: string | undefined): string | null => value === undefined ? null : time(value)
/** Sorted-key canonical JSON, restricted here to the observation's digest/enum/null/timestamp payload. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  return JSON.stringify(value)
}

/** Pure projection: no prose, raw identifiers, paths, environment, prompt text or inferred verification. */
export function dalObservation(ticket: Pick<Ticket, 'id' | 'mandate' | 'updatedAt' | 'ended' | 'assignments'>, workspace: string) {
  if (ticket.assignments.length > 1000) throw new Error('DAL observation exceeds the assignment limit')
  const workspaceHash = hash(workspace)
  const identity = (kind: string, id: string) => hash(JSON.stringify([workspaceHash, kind, ticket.id, id]))
  const payload = {
    $schema: 'https://recursive-dev-loop.dev/schemas/superagent-observation.v1.schema.json',
    schema_version: '1.0.0' as const,
    producer: 'dsh-superagent' as const,
    workspace_sha256: workspaceHash,
    ticket_sha256: identity('ticket', ticket.id),
    session_sha256: identity('session', workerSessionId(ticket.id)),
    policy_sha256: hash(ticket.mandate.policyVersion),
    updated_at: time(ticket.updatedAt),
    ticket_state: member(ticket.ended?.outcome ?? 'open', ['open', 'completed', 'merged', 'closed', 'dropped', 'stopped']),
    assignments: ticket.assignments.map(item => ({
      assignment_sha256: identity('assignment', item.id),
      state: member(item.state, ['pending', 'running', 'ended']),
      created_at: time(item.createdAt),
      started_at: optionalTime(item.startedAt),
      ended_at: optionalTime(item.endedAt),
      report_state: item.report ? member(item.report.state, ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']) : null,
      report_at: optionalTime(item.report?.at),
      idle_at: optionalTime(item.idleAt),
    })),
    verification: 'unverified' as const,
    runtime_assurance: 'unattested' as const,
    promotion_authority: 'none' as const,
  }
  if (new Set(payload.assignments.map(item => item.assignment_sha256)).size !== payload.assignments.length) {
    throw new Error('DAL observation repeats an assignment identity')
  }
  return { ...payload, observation_id: `obs-${hash(canonical(payload))}` }
}
export type DalObservation = ReturnType<typeof dalObservation>
