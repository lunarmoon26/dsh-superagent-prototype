/** Joined native-model flow. Local Source/controller bridges are explicit; no model-generated command is executed. */
import type { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Runtime } from '../../../src/app/runtime.ts'
import { Store } from '../../../src/app/store.ts'
import { SettingsSchema } from '../../../src/policy.ts'
import { feishuKind, feishuTrigger } from '../../../src/sources/feishu.ts'
import { githubKind } from '../../../src/sources/github.ts'
import { strategyPin, workerEvidenceView } from '../../../src/app/worker-evidence.ts'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

const run = promisify(execFile)
const reference = <T,>(value: T) => ({ get: () => value })
export async function nativeFlow(ctx: Context, output: string, provider: string, model: string,
  mount: (name: string, config?: unknown) => Promise<void>, metrics: () => { requests: number; usage: unknown[]; errors: string[] }) {
  // Only the public Task instruction crosses this boundary; no grader, hidden cases or requested host commands.
  const evaluation = process.env.NATIVE_EVAL_TASK ? z.object({ version: z.literal(1), task_id: z.string().regex(/^[a-z][a-z0-9-]+$/),
    task_sha256: z.string().regex(/^[a-f0-9]{64}$/), instruction: z.string().min(1).max(12_000) }).strict()
    .parse(JSON.parse(readFileSync(process.env.NATIVE_EVAL_TASK, 'utf8'))) : undefined
  const workerTask = evaluation ? `Implement this pure Python task: ${evaluation.instruction}\nCall write once with the complete solution.py source in content. No paths or commands are accepted. Do not run code or tests; the independent evaluator checks it afterward. Then report ready with no PR and finish.`
    : 'Synthetic worker smoke only. The entire task is one write call with content NATIVE-READY plus a newline. Do not acknowledge, run commands, make commits, open PRs, use other tools or post messages. After write, report ready with no PR and finish.'
  await mount('dsh-subprocess-local'); await mount('dsh-jobs-local')
  const state = join(output, 'state'); mkdirSync(state)
  const gh = join(output, 'synthetic-gh')
  writeFileSync(gh, `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='api'&&a[1]==='user') console.log(JSON.stringify({login:'smoke-agent',id:7}));\nelse if(a[0]==='api'&&a[1]==='repos/synthetic/smoke') console.log(JSON.stringify({name:'synthetic/smoke',push:true}));\nelse process.exit(97);\n`, { mode: 0o700 })
  const seed = new Store(join(state, 'orchestrator.sqlite'))
  seed.saveSettings(SettingsSchema.parse({ sources: { github: { enabled: true, config: { repository: 'synthetic/smoke', cli: gh } },
    feishu: { enabled: true, config: { chats: [{ chatId: 'oc_smoke', listen: 'all' }], directMessages: true } } },
    policy: { sources: { feishu: { allowed: [{ id: 'ou_smoke', name: 'Synthetic operator' }] } } },
    executor: { maxWorkers: 1, prepare: 'git init -q "$DSH_SUPERAGENT_DIR"' } }))
  seed.close()
  const handles: AgentHandle[] = []
  const workspaces = new Map<string, string>()
  ctx.reflect.provide('workspaceRegistry', { create: async (cwd: string) => { workspaces.set(cwd, cwd); return { id: cwd } } } as never)
  ctx.reflect.provide('sessionController', {
    resolveAgent: async (id: SessionId) => ctx.agents.get(id) ? { agent: ctx.agents.get(id) } : { error: { code: 'session/not-found' } },
    create: async ({ sessionId, workspaceId, agentPreset }: { sessionId: SessionId; workspaceId: string; agentPreset: string }) => {
      handles.push(await ctx.agents.create({ sessionId, meta: { cwd: workspaces.get(workspaceId)!, agentPreset },
        agentOptions: { provider, model, maxTokens: 1024 } }))
    }, rename: async () => {}, selectModel: async () => {}, modelCatalog: async () => ({ providers: [] }),
  } as never)
  ctx.reflect.provide('permissionPresets', { set: () => {} } as never)
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const server = createServer((req, res) => {
    if (req.url === '/panel.js') { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(join(output, 'panel.js'))); return }
    if (req.url === '/' || req.url === '/?lang=zh') { res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>Native Superagent smoke</title></head><body><div id="root"></div><script src="/panel.js"></script></body></html>'); return }
    if (!handler) { res.writeHead(503); res.end(); return }
    void handler(req, res).catch(() => { res.writeHead(500); res.end('{"error":"Native management failure"}') })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native HTTP port')
  ctx.reflect.provide('webServer', { host: '127.0.0.1', port: address.port,
    register: (route: { handler: typeof handler }) => { handler = route.handler; return () => { handler = undefined } } } as never)
  let runtime: Runtime | undefined, writes = 0
  for (const name of ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill']) {
    ctx.tools.register({ name, description: 'Unavailable in this fixed-output smoke. Do not call.', parameters: { type: 'object' },
      execute: async () => { throw new Error('Tool deliberately unavailable in the native smoke') },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'Unavailable' }] } })
  }
  ctx.tools.register({ name: 'write', description: evaluation ? 'Save solution.py as data for a separate sandbox evaluator. Pass only content containing complete Python source, at most 32768 UTF-8 bytes. This never executes code.' : 'Write the synthetic result. Pass only content=NATIVE-READY followed by one newline. No path, command or other field is accepted.',
    parameters: { type: 'object', additionalProperties: false, required: ['content'], properties: { content: evaluation
      ? { type: 'string', minLength: 1, maxLength: 32768 } : { type: 'string', const: 'NATIVE-READY\n' } } },
    execute: async input => {
      const value = z.object({ content: evaluation ? z.string().min(1).max(32768) : z.literal('NATIVE-READY\n') }).strict().parse(input)
      if (Buffer.byteLength(value.content) > 32768) throw new Error('Source artifact exceeds its byte allocation')
      if (++writes > 1 || !runtime) throw new Error('Native write allocation exhausted')
      const ticket = runtime.store.tickets.list()[0]!
      writeFileSync(join(ticket.execution!.directory, evaluation ? 'solution.py' : 'result.txt'), value.content)
      const previous = runtime.prompts.current()
      runtime.prompts.save({ ...previous.config, delivery: 'Successor revision; the current Assignment must not switch.' }, previous.revision, 'panel')
      return { saved: true }
    }, output: { schema: { type: 'object' }, render: (_input, result) => [{ type: 'text', text: JSON.stringify(result) }] },
  })
  try {
    runtime = new Runtime(ctx, { stateDir: state, promptMaxChars: reference(100_000), admissionContextMaxPages: reference(10),
      admissionContextTimeoutMs: reference(15_000) }, () => { throw new Error('Unexpected native runtime restart') })
    await runtime.ready
    if (!runtime.configured()) throw new Error(`Native setup failed: ${runtime.setupProblem?.code}`)
    runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
    const original = runtime.prompts.current()
    runtime.prompts.save({ ...original.config, communication: '', scope: '', delivery: '', overrides: {
      'runtime/shared': { text: 'Synthetic local smoke only. Follow your own router or worker role. No external posting, commits or pushes are permitted.' },
      ...Object.fromEntries(['runtime/worker', 'runtime/work', 'runtime/handoff/worker'].map(name => [name,
        { text: workerTask }])),
      'runtime/subscriptions': { text: 'This synthetic task needs no new subscriptions.' },
      'runtime/replies': { text: 'There is no external reply channel in this synthetic smoke; do not call acknowledgement or reply tools.' },
    } }, original.revision, 'panel')
    const trigger = feishuTrigger({ message_id: 'om_native', chat_id: 'oc_smoke', chat_type: 'group', sender_id: 'ou_smoke',
      sender_type: 'user', content: evaluation ? workerTask : 'Write the synthetic result using the write tool: NATIVE-READY followed by a newline. No other work or external action. Then report ready.',
      create_time: String(Date.now()), mentions: [{ id: 'ou_smoke_bot' }] }, 'ou_smoke_bot', 'cli_smoke')!
    delete trigger.channel
    runtime.receive(trigger)
    // Bounded application-level wait; native router and worker drive their real Agent loops independently.
    await new Promise<void>((resolve, reject) => {
      const started = Date.now()
      const timer = setInterval(() => {
        const failure = metrics().errors[0]
        const ticket = runtime!.store.tickets.list()[0]
        if (failure || Date.now() - started > 150_000) { clearInterval(timer); reject(new Error(failure ?? 'Native flow timed out')); return }
        if (writes === 1 && ticket?.assignments[0]?.report?.state === 'ready') { clearInterval(timer); resolve() }
      }, 100)
    })
    await Promise.all(handles.map(handle => handle.agent.whenIdle()))
    if (metrics().errors.length || writes !== 1 || runtime.store.tickets.list().length !== 1) throw new Error('Native flow did not finish exactly one clean Ticket/file workflow')
    const ticket = runtime.store.tickets.list()[0]!, assignment = ticket.assignments[0]!
    const pin = strategyPin(runtime.store, ticket.id, assignment.id)
    if (!pin || pin.manifest.prompt_revision !== 1 || runtime.prompts.current().revision !== 2) throw new Error('Native flow did not retain the worker Assignment revision')
    const artifact = join(ticket.execution!.directory, 'result.txt')
    if (evaluation) {
      // Capture exact output bytes, never import/execute them on the host and never declare a task grade here.
      writeFileSync(join(output, 'solution.py'), readFileSync(join(ticket.execution!.directory, 'solution.py')))
      await ctx.sessionPersistence.flush()
      writeFileSync(join(output, 'receipts.json'), JSON.stringify({ status: 'passed', provider, model, ...metrics(), writes, pin,
        evaluation_task: { task_id: evaluation.task_id, task_sha256: evaluation.task_sha256 }, worker_report: assignment.report,
        billing: { spend_authorized: true, monetary_cost: null },
        coverage: { live_router: true, live_worker: true, production_runtime: true, controller_bridge: true, workspace_bridge: true,
          permission_preset_shim: true, code_written_as_data: true, generated_code_executed: false,
          independent_task_evaluation: false, external_source: false, promotion: false } }, null, 2) + '\n')
      return
    }
    writeFileSync(join(output, 'altered.txt'), 'not the native artifact\n')
    const python = process.env.E2E_PYTHON!, script = process.env.E2E_BROWSER_SCRIPT!, dal = process.env.DAL_CLI!
    await run(python, [script, '--url', `http://127.0.0.1:${address.port}`, '--ticket', ticket.id, '--artifact', artifact,
      '--out', output, '--marker', 'NATIVE-READY', '--chromium', process.env.E2E_CHROMIUM ?? '/usr/bin/google-chrome'], { timeout: 90_000, maxBuffer: 1024 * 1024 })
    const evidence = workerEvidenceView(runtime.store, ticket)
    if (evidence.current?.receipts.length !== 2 || evidence.current.receipts.at(-1)?.status !== 'passed') throw new Error('Native browser did not verify supplied bytes')
    const results = []
    for (const action of ['validate', 'ingest', 'ingest']) results.push(JSON.parse((await run(process.execPath,
      [dal, 'observe', action, join(output, 'observation.json'), ...(action === 'ingest' ? ['--store', '.dal/observations'] : [])],
      { cwd: output, timeout: 30_000 })).stdout))
    if (results.map(item => item.status).join() !== 'valid,stored,idempotent') throw new Error('Native flow DAL ingestion failed')
    await ctx.sessionPersistence.flush()
    const stats = metrics()
    writeFileSync(join(output, 'receipts.json'), JSON.stringify({ status: 'passed', provider, model, ...stats, writes, pin, evidence, dal: results,
      billing: { spend_authorized: true, monetary_cost: null, note: 'Native OAuth provider usage; monetary billing is not measured.' },
      coverage: { native_agent_loop: true, live_router: true, live_worker: true, native_model_adapter: true, live_model: true,
        production_runtime: true, production_sessions: true, production_executor: true, real_http: true, real_chromium: true, real_sqlite: true,
        native_profile: false, controller_bridge: true, workspace_bridge: true, permission_preset_shim: true, fixed_output_tool: true,
        generated_commands: false, external_source: false, independent_principal: false, semantic_task_evaluation: false, promotion: false } }, null, 2) + '\n')
  } finally {
    try { await runtime?.stop(); for (const handle of handles) await handle.dispose() }
    finally { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) }
  }
}
