/** Opt-in real HTTP/Chromium workflow; only model and external Source boundaries are scripted. */
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { strategyPin, workerEvidenceView } from '../src/app/worker-evidence.ts'

const run = promisify(execFile)
it.runIf(process.env.DSH_E2E === '1')('joins source, routing, worker pin, browser file checks, restart and built DAL ingestion', async () => {
  const root = resolve('.artifacts/e2e'); mkdirSync(root, { recursive: true })
  const output = mkdtempSync(join(root, 'run-')), state = join(output, 'state'); mkdirSync(state)
  const python = resolve(process.env.E2E_PYTHON ?? '.artifacts/e2e-venv/bin/python')
  const dal = resolve(process.env.DAL_CLI ?? '../dsh-adaptive-loop/dist/cli.js')
  if (!existsSync(python)) throw new Error('E2E Python is missing; install tests/fixtures/e2e/requirements.txt in .artifacts/e2e-venv or set E2E_PYTHON')
  if (!existsSync(dal)) throw new Error('Built DAL CLI is missing; build the sibling DAL repository or set DAL_CLI')
  const { build } = await import('tsdown')
  await build({ config: false, entry: { panel: 'tests/fixtures/e2e/panel.tsx' }, outDir: output, format: 'iife', platform: 'browser',
    dts: false, clean: false, deps: { alwaysBundle: [/.*/], onlyBundle: false }, outputOptions: { entryFileNames: 'panel.js' },
    plugins: [{ name: 'raw-css', resolveId(source, importer) {
      return source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined
    }, load(id) { return id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' } : undefined } }],
  })
  let host: Host | undefined
  const server = createServer((req, res) => {
    if (req.url === '/panel.js') { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(join(output, 'panel.js'))); return }
    if (req.url === '/' || req.url === '/?lang=zh') {
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta charset="utf-8"><title>Superagent E2E</title></head><body><div id="root"></div><script src="/panel.js"></script></body></html>'); return
    }
    if (!host) { res.writeHead(503); res.end(); return }
    void host.handler(req, res).catch(error => { res.writeHead(500); res.end(String(error)) })
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback port')
  const url = `http://127.0.0.1:${address.port}`
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}/orchestrator/api/${path}`, { method, headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  const browser = async (ticket: string, artifact: string, phase: string) => {
    try {
      await run(python, ['tests/fixtures/e2e/browser.py', '--url', url, '--ticket', ticket, '--artifact', artifact, '--out', output,
        '--phase', phase, '--chromium', process.env.E2E_CHROMIUM ?? '/usr/bin/google-chrome'], { timeout: 90_000, maxBuffer: 1024 * 1024 })
    } catch (error) { writeFileSync(join(output, `browser-${phase}-error.txt`), String(error)); throw error }
  }
  try {
    host = await startRuntime(undefined, { directory: state, port: address.port })
    const { ticket, sessionId } = await host.acceptedTicket(feishu('e2e1', 'Produce result.txt containing E2E-READY. Do not post or push anything.'))
    const assignment = ticket.assignments.at(-1)!
    expect(host.runtime.store.tickets.list()).toHaveLength(1)
    host.sections.get(sessionId)!.text({})
    expect(strategyPin(host.runtime.store, ticket.id, assignment.id)).toBeUndefined()
    host.sections.get(sessionId)!.text({ signal: new AbortController().signal })
    const pin = strategyPin(host.runtime.store, ticket.id, assignment.id)!
    const current = host.runtime.prompts.current()
    expect((await api('PUT', 'prompts', { config: { ...current.config, delivery: `${current.config.delivery}\nE2E successor revision.` },
      baseRevision: current.revision })).status).toBe(200)
    host.sections.get(sessionId)!.text({ signal: new AbortController().signal })
    expect(strategyPin(host.runtime.store, ticket.id, assignment.id)).toEqual(pin)
    const artifact = join(ticket.execution!.directory, 'result.txt')
    // Scripted worker boundary: a known fixture produces real file bytes, never model-generated host commands.
    mkdirSync(dirname(artifact), { recursive: true }); writeFileSync(artifact, 'E2E-READY\n')
    writeFileSync(join(output, 'altered.txt'), 'not the required artifact\n')
    await host.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Synthetic worker awaits operator artifact checks' })
    await browser(ticket.id, artifact, 'initial')
    const evidence = workerEvidenceView(host.runtime.store, host.runtime.store.tickets.get(ticket.id)!)
    expect(evidence.current?.receipts).toHaveLength(2)
    const contract = evidence.current!.contract!
    const replay = { assignment_id: assignment.id, generation_id: pin.generation_id, contract_id: contract.id,
      artifact_base64: readFileSync(artifact).toString('base64') }
    const first = await api('POST', `tickets/${ticket.id}/artifact-check`, replay)
    expect(await api('POST', `tickets/${ticket.id}/artifact-check`, replay)).toEqual(first)
    expect((await api('POST', `tickets/${ticket.id}/artifact-check`, { ...replay, artifact_base64: '!invalid' })).status).toBe(400)
    const forbidden = await fetch(`${url}/orchestrator/api/tickets/${ticket.id}/worker-evidence`, { headers: { 'x-orchestrator-request': '1', origin: 'http://evil.example' } })
    expect(forbidden.status).toBe(403)
    // Real SQLite and Runtime reopen; DSH Session internals remain the declared scripted boundary.
    await host.stop(true); host = undefined
    host = await startRuntime(undefined, { directory: state, port: address.port })
    const restored = host.runtime.store.tickets.get(ticket.id)!
    await host.runtime.sessions.ensure(sessionId, restored.execution!.directory, restored.title, 'worker')
    host.sections.get(sessionId)!.text({ signal: new AbortController().signal })
    expect(strategyPin(host.runtime.store, ticket.id, assignment.id)).toEqual(pin)
    expect(workerEvidenceView(host.runtime.store, restored).current?.receipts).toHaveLength(2)
    expect((await api('POST', `tickets/${ticket.id}/retry`)).status).toBe(200)
    await host.runtime.idle()
    host.sections.get(sessionId)!.text({ signal: new AbortController().signal })
    const successor = host.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!
    expect(successor.id).not.toBe(assignment.id)
    expect(strategyPin(host.runtime.store, ticket.id, successor.id)?.manifest.prompt_revision).toBe(current.revision + 1)
    expect((await api('POST', `tickets/${ticket.id}/artifact-check`, replay)).status).toBe(409)
    await browser(ticket.id, artifact, 'history')
    const observation = JSON.parse(readFileSync(join(output, 'observation.json'), 'utf8'))
    expect(observation).toMatchObject({ verification: 'unverified', runtime_assurance: 'unattested', promotion_authority: 'none' })
    const results = []
    for (const action of ['validate', 'ingest', 'ingest']) {
      const command = ['observe', action, join(output, 'observation.json'), ...(action === 'ingest' ? ['--store', '.dal/observations'] : [])]
      results.push(JSON.parse((await run(process.execPath, [dal, ...command], { cwd: output, timeout: 30_000 })).stdout))
    }
    expect(results.map(item => item.status)).toEqual(['valid', 'stored', 'idempotent'])
    writeFileSync(join(output, 'receipts.json'), JSON.stringify({ status: 'passed', coverage: { real_runtime: true, real_sqlite: true,
      real_http: true, real_chromium: true, scripted_dsh_services: true, scripted_source: true, live_model: false,
      built_dal_cli: true, independent_task_evaluation: false, promotion: false }, ticket_id: ticket.id,
      assignment_id: assignment.id, successor_id: successor.id, generation_id: pin.generation_id, dal: results }, null, 2) + '\n')
    console.log(`E2E evidence: ${output}`)
  } finally {
    try { await host?.stop(true) } finally { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) }
  }
}, 180_000)
