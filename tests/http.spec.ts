import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { dalTicket } from './fixtures/dal.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { bindStrategy } from '../src/app/worker-evidence.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>

it('exports DAL observations only through the read-only same-origin management route', async () => {
  const ticket = dalTicket(), before = structuredClone(ticket)
  const call = serve({ masterId: 'fixture-workspace', store: { tickets: { get: (id: string) => id === ticket.id ? ticket : undefined } } })
  const path = `tickets/${ticket.id}/dal-observation`
  expect(await call('GET', path)).toMatchObject({ status: 200, body: { producer: 'dsh-superagent', verification: 'unverified' } })
  expect(await call('GET', path, undefined, { origin: 'http://evil.example' })).toMatchObject({ status: 403 })
  expect(await call('GET', path, undefined, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
  expect(await call('POST', path)).toMatchObject({ status: 404 })
  expect(await call('GET', 'tickets/missing/dal-observation')).toMatchObject({ status: 404 })
  expect(ticket).toEqual(before)
})

it('protects frozen artifact checks, bounds bodies and refuses stale bindings without changing ticket acceptance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-http-')), store = new Store(join(directory, 'db.sqlite'))
  try {
    const ticket = dalTicket(), original = structuredClone(ticket), assignment = ticket.assignments.at(-1)!
    store.tickets.save(ticket)
    const pin = bindStrategy(store, ticket.id, assignment.id, 0, 'prompt', 'context', [], true)
    const call = serve({ store }), base = `tickets/${ticket.id}`
    const request = { assignment_id: assignment.id, generation_id: pin.generation_id,
      checks: [{ id: 'required', kind: 'contains', value: 'expected' }] }
    for (const [method, path, value] of [['GET', 'worker-evidence', undefined], ['PUT', 'artifact-contract', request],
      ['POST', 'artifact-check', {}]] as const) {
      expect(await call(method, `${base}/${path}`, value, { origin: 'http://evil.example' })).toMatchObject({ status: 403 })
    }
    expect(await call('GET', `${base}/worker-evidence`)).toMatchObject({ status: 200, body: { current: { pin, contract: null } } })
    expect(await call('PUT', `${base}/artifact-contract`, { ...request, checks: [] })).toMatchObject({ status: 400 })
    const frozen = await call('PUT', `${base}/artifact-contract`, request)
    expect(frozen.status).toBe(200)
    expect(await call('PUT', `${base}/artifact-contract`, request)).toEqual(frozen)
    expect(await call('PUT', `${base}/artifact-contract`, { ...request, checks: [{ ...request.checks[0], value: 'changed' }] }))
      .toMatchObject({ status: 409 })
    const upload = { assignment_id: assignment.id, generation_id: pin.generation_id, contract_id: frozen.body.id,
      artifact_base64: Buffer.from('expected file').toString('base64') }
    const checked = await call('POST', `${base}/artifact-check`, upload)
    expect(checked).toMatchObject({ status: 200, body: { status: 'passed', scope: 'supplied-artifact-only' } })
    expect(await call('POST', `${base}/artifact-check`, upload)).toEqual(checked)
    expect(await call('POST', `${base}/artifact-check`, { ...upload, artifact_base64: '!invalid' })).toMatchObject({ status: 400 })
    expect(await call('POST', `${base}/artifact-check`, { ...upload, artifact_base64: 'A'.repeat(1403000) })).toMatchObject({ status: 400 })
    expect(await call('PUT', `${base}/artifact-contract`, ' '.repeat(256 * 1024 + 1))).toMatchObject({ status: 400 })
    expect(store.tickets.get(ticket.id)).toEqual(original)
    ticket.assignments.push({ ...assignment, id: 'successor' }); store.tickets.save(ticket)
    expect(await call('POST', `${base}/artifact-check`, upload)).toMatchObject({ status: 409 })
    expect(await call('PUT', `${base}/artifact-contract`, request)).toMatchObject({ status: 409 })
    expect(await call('GET', 'tickets/missing/worker-evidence')).toMatchObject({ status: 404 })
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1', port: number | null = 3082) {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: port ?? undefined, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
  // rc.5 can expose the server before it has bound a TCP port; do not guess one from request headers.
  expect(await serve({}, '127.0.0.1', null)('GET', 'state')).toMatchObject({ status: 403 })
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
