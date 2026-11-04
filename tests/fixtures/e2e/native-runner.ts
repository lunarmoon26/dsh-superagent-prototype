/** Builds a private native smoke host against the installed DSH, not a production profile. */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { build } from 'tsdown'

const root = resolve('.artifacts/native-smoke'); mkdirSync(root, { recursive: true })
const output = mkdtempSync(join(root, 'run-'))
const fullFlow = !process.argv.includes('--agent-only')
const taskIndex = process.argv.indexOf('--task')
if (taskIndex !== -1 && (!fullFlow || !process.argv[taskIndex + 1])) throw new Error('--task needs a path and the joined native flow')
const evaluationTask = taskIndex === -1 ? undefined : resolve(process.argv[taskIndex + 1]!)
const python = resolve(process.env.E2E_PYTHON ?? '.artifacts/e2e-venv/bin/python')
const dal = resolve(process.env.DAL_CLI ?? '../dsh-adaptive-loop/dist/cli.js')
if (fullFlow && !evaluationTask) {
  if (!existsSync(python) || !existsSync(dal) || !existsSync(process.env.E2E_CHROMIUM ?? '/usr/bin/google-chrome')) {
    throw new Error('Native flow needs E2E_PYTHON, E2E_CHROMIUM and a built DAL_CLI; see docs/011-end-to-end.md')
  }
  execFileSync(python, ['-c', 'import playwright.sync_api'], { stdio: 'ignore' })
}
const dshRoot = process.env.DSH_PACKAGE_ROOT ?? dirname(dirname(realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())))
const require = createRequire(join(dshRoot, 'package.json'))
if (JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8')).version !== '0.2.1-rc.5') throw new Error('Native smoke requires the verified DSH 0.2.1-rc.5 installation')
await build({ config: false, entry: { 'native-host': 'tests/fixtures/e2e/native-host.ts' }, outDir: output, format: 'esm',
  platform: 'node', dts: false, clean: false, outputOptions: { entryFileNames: 'native-host.mjs' },
  plugins: [{ name: 'one-native-dsh-install', resolveId(id) {
    if (id.startsWith('@deepseek-ai/')) return { id: require.resolve(id), external: true }
  } }],
})
if (fullFlow && !evaluationTask) await build({ config: false, entry: { panel: 'tests/fixtures/e2e/panel.tsx' }, outDir: output, format: 'iife', platform: 'browser',
  dts: false, clean: false, deps: { alwaysBundle: [/.*/], onlyBundle: false }, outputOptions: { entryFileNames: 'panel.js' },
  plugins: [{ name: 'raw-css', resolveId(source, importer) { return source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined },
    load(id) { return id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' } : undefined } }],
})
const home = join(output, 'home'); mkdirSync(home)
const credentialStore = process.env.NATIVE_CREDENTIAL_STORE ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
try {
  const execution = await promisify(execFile)(process.execPath, [join(output, 'native-host.mjs'), dshRoot, output], {
    cwd: output, timeout: 210_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', NATIVE_CREDENTIAL_STORE: credentialStore,
      NATIVE_FULL_FLOW: fullFlow ? '1' : '0', E2E_PYTHON: python,
      NATIVE_EVAL_TASK: evaluationTask ?? '',
      E2E_BROWSER_SCRIPT: resolve('tests/fixtures/e2e/browser.py'), DAL_CLI: dal },
  })
  writeFileSync(join(output, 'native.log'), execution.stdout + execution.stderr)
  if (!existsSync(join(output, 'receipts.json'))) throw new Error('Native host produced no success receipt')
  const receipt = JSON.parse(readFileSync(join(output, 'receipts.json'), 'utf8'))
  const result = { status: receipt.status, requests: receipt.requests, provider: receipt.provider, model: receipt.model, evidence: join(output, 'receipts.json') }
  writeFileSync(join(output, 'runner-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} catch (failure) {
  const error = failure as { stdout?: string; stderr?: string; killed?: boolean }
  writeFileSync(join(output, 'native.log'), String(error.stdout ?? '') + String(error.stderr ?? ''))
  const result = { status: 'failed', evidence: output, timed_out: !!error.killed }
  writeFileSync(join(output, 'runner-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.error(JSON.stringify(result))
  process.exitCode = 1
}
