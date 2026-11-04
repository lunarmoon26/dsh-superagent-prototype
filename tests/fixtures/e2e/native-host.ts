/** Opt-in real DSH Agent/LLM smoke. The model has one fixed-output data tool, no shell or arbitrary filesystem access. */
import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Store } from '../../../src/app/store.ts'
import { Prompts, defaultPrompts } from '../../../src/app/prompts.ts'
import { Sessions } from '../../../src/app/sessions.ts'
import { ArtifactChecks, strategyPin } from '../../../src/app/worker-evidence.ts'
import { dalTicket } from '../dal.ts'
import { nativeFlow } from './native-flow.ts'

const [dshRoot, output] = process.argv.slice(2)
if (!dshRoot || !output) throw new Error('Pass the installed DSH package root and an isolated output directory')
const require = createRequire(join(dshRoot, 'package.json'))
const load = async (name: string) => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const credentialPath = process.env.NATIVE_CREDENTIAL_STORE ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
const credentials = await load('dsh-credentials-local')
if (existsSync(credentialPath) && credentials.renderFlatLayoutMigration(readFileSync(credentialPath, 'utf8')) !== undefined) {
  throw new Error('Refusing to migrate the shared credential store during a smoke test')
}
mkdirSync(output, { recursive: true, mode: 0o700 })
const ctx = new Context(), lifetime = new AbortController(), store = new Store(join(output, 'native.sqlite'))
let sessions: Sessions | undefined
let requests = 0, writes = 0, changedRevision = false
const usage: unknown[] = [], errors: string[] = []
const timeline: { session: string; type: string }[] = []
const deadline = setTimeout(() => lifetime.abort(), 180_000)
const mount = async (name: string, config?: unknown) => {
  const plugin = await load(name)
  await ctx.plugin(plugin.default ?? plugin, config)
}
try {
  await mount('dsh-llm')
  await ctx.plugin(credentials.default, { path: credentialPath, watch: false })
  const records = await (ctx as unknown as { credentials: { listRecords(): Promise<{ key: string; kind: string }[]> } }).credentials.listRecords()
  if (!records.some((record: { key: string; kind: string }) => record.key === 'llm-pi-ai/openai-codex' && record.kind === 'grant')) {
    throw new Error('NATIVE_OAUTH_REQUIRED: no native openai-codex grant is configured')
  }
  const provider = 'openai-codex'
  await mount('dsh-llm-pi-ai', { providers: { [provider]: { reasoning: 'low', transport: 'sse',
    retryPolicy: { mode: 'normal', maxRetries: 0 }, timeoutMs: 60_000, streamIdleTimeoutMs: 60_000 } } })
  const catalog = await ctx.llm.listModels(provider)
  const model = process.env.NATIVE_MODEL ?? 'gpt-6.1-sol'
  if (!catalog.some(item => item.id === model)) throw new Error('Requested native model is not in the installed provider catalog')
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-skill']) await mount(name)
  await mount('dsh-session-persistence-jsonl', { root: join(output, 'sessions') })
  await mount('dsh-agent-loop', { agents: [] })
  ctx.on('session/event', (session, event) => {
    if (timeline.length < 1000) timeline.push({ session: session.id, type: event.type })
    writeFileSync(join(output, 'timeline.json'), JSON.stringify(timeline))
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (++requests > 8 || lifetime.signal.aborted || Buffer.byteLength(JSON.stringify(options)) > 128 * 1024
      || options.maxTokens === undefined || options.maxTokens > 1024) throw new Error('Native smoke request allocation exhausted')
    writeFileSync(join(output, 'allocation.json'), JSON.stringify({ requests, usage }))
    for await (const chunk of next()) {
      if (chunk.type === 'usage') { usage.push(chunk.usage); writeFileSync(join(output, 'allocation.json'), JSON.stringify({ requests, usage })) }
      yield chunk
    }
  })
  ctx.on('agent/error', event => { errors.push(String((event as { error?: unknown }).error ?? 'native agent error')) })
  if (process.env.NATIVE_FULL_FLOW === '1') {
    await nativeFlow(ctx, output, provider, model, mount, () => ({ requests, usage, errors }))
    console.log(JSON.stringify({ status: 'passed', requests, provider, model, evidence: join(output, 'receipts.json') }))
  } else {
  // A narrow controller bridge resolves the real native Agent; no model loop, tool dispatch or prompt assembly is mocked.
  ctx.reflect.provide('sessionController', { resolveAgent: async (id: string) => ({ agent: ctx.agents.get(id as never) }),
    rename: async () => {}, selectModel: async () => {} } as never)
  // No OS-execution tools are mounted. This shim cannot grant powers; production full-access presets are not exercised.
  ctx.reflect.provide('permissionPresets', { set: () => {} } as never)
  const ticket = dalTicket(); ticket.id = 'native-smoke-ticket'; ticket.assignments = [ticket.assignments.at(-1)!]
  ticket.assignments[0]!.id = 'native-smoke-assignment'
  store.tickets.save(ticket)
  const prompts = new Prompts(store, () => 100_000, () => [], () => false)
  const config = defaultPrompts()
  config.communication = ''; config.scope = ''; config.delivery = ''
  config.overrides = Object.fromEntries(['runtime/shared', 'runtime/worker', 'runtime/subscriptions', 'runtime/replies', 'runtime/work',
    'runtime/handoff/worker'].map(name => [name, { text: 'This is a synthetic constrained native runtime smoke test. No external actions are available.' }]))
  prompts.save(config, 0, 'panel')
  const effects = { handle: () => {}, enqueue: () => {}, idle: async () => {}, pending: () => false }
  sessions = new Sessions({ context: ctx, store, prompts, effects: effects as never, masterId: 'native-no-router', lifetime: lifetime.signal,
    health: { set: () => {} } as never, closing: () => lifetime.signal.aborted, environment: () => [], tools: () => [] })
  sessions.install()
  ctx.tools.register({ name: 'write', description: 'Save the synthetic result. The only permitted content is NATIVE-READY followed by a newline. No paths or commands are accepted.',
    parameters: { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { type: 'string', const: 'NATIVE-READY\n' } } },
    execute: async (input: unknown) => {
      const value = input as { content?: unknown }
      if (value.content !== 'NATIVE-READY\n' || Object.keys(value).length !== 1 || writes >= 1) throw new Error('Fixed-output tool refuses this input')
      writes++; writeFileSync(join(output, 'result.txt'), value.content)
      const previous = prompts.current()
      prompts.save({ ...previous.config, delivery: 'A successor Assignment uses this revision.' }, previous.revision, 'panel')
      changedRevision = true
      return { saved: true }
    }, output: { schema: { type: 'object' }, render: (_input: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
  })
  const sessionId = `worker-${ticket.id}`
  const handle = await ctx.agents.create({ sessionId: sessionId as never, meta: { cwd: output }, agentOptions: { provider, model, maxTokens: 1024 } })
  const agent = ctx.agents.get(sessionId as never)!
  await sessions.ensure(sessionId, output, 'Native smoke', 'worker')
  const stopOnAbort = () => { agent.cancel({ kind: 'user' }) }
  lifetime.signal.addEventListener('abort', stopOnAbort, { once: true })
  await sessions.prompt(sessionId, 'native-smoke-request', 'Call write with content exactly NATIVE-READY followed by one newline. This is the entire task. Then finish with a short confirmation. No other actions.', 'queue')
  await agent.whenIdle()
  lifetime.signal.removeEventListener('abort', stopOnAbort)
  if (lifetime.signal.aborted || errors.length || writes !== 1 || !changedRevision || requests < 2) throw new Error('Native agent did not complete the bounded tool workflow')
  const pin = strategyPin(store, ticket.id, ticket.assignments[0]!.id)
  if (!pin || pin.manifest.prompt_revision !== 1 || prompts.current().revision !== 2) throw new Error('Native requests did not enforce the Assignment pin')
  const checks = new ArtifactChecks(store), contract = checks.contract(ticket, { assignment_id: pin.assignment_id, generation_id: pin.generation_id,
    checks: [{ id: 'native-result', kind: 'contains', value: 'NATIVE-READY' }] })
  const receipt = checks.verify(ticket, { assignment_id: pin.assignment_id, generation_id: pin.generation_id, contract_id: contract.id,
    artifact_base64: readFileSync(join(output, 'result.txt')).toString('base64') })
  if (receipt.status !== 'passed') throw new Error('Native artifact failed its literal check')
  await ctx.sessionPersistence.flush()
  writeFileSync(join(output, 'receipts.json'), JSON.stringify({ status: 'passed', provider, model, requests, writes, usage, pin, receipt,
    billing: { spend_authorized: true, monetary_cost: null, note: 'Native OAuth provider usage; monetary billing is not measured.' },
    coverage: { native_agent_loop: true, native_model_adapter: true, live_model: true, production_sessions: true, real_sqlite: true,
      native_profile: false, controller_bridge: true, permission_preset_shim: true, fixed_output_tool: true, generated_commands: false,
      external_source: false, independent_principal: false, semantic_task_evaluation: false, promotion: false } }, null, 2) + '\n')
  await handle.dispose()
  console.log(JSON.stringify({ status: 'passed', requests, provider, model, evidence: join(output, 'receipts.json') }))
  }
} catch (error) {
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ status: 'failed', requests, writes, error: error instanceof Error ? error.message : 'Unknown native smoke failure', errors }, null, 2))
  throw error
} finally {
  clearTimeout(deadline); lifetime.abort()
  sessions?.dispose()
  await ctx.fiber.dispose()
  store.close()
}
