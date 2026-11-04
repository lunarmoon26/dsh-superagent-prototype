/** Native Ticket evidence: partial strategy pins and frozen checks over operator-supplied bytes, never task acceptance. */
import { useState, type ReactNode } from 'react'
import type { ArtifactContract, WorkerEvidenceView } from '../app/worker-evidence.ts'
import { usePoll } from './api.ts'
import { Button, Input } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { ConfirmButton, Hint, KeyValues, LoadState, When } from './widgets.tsx'

type AssignmentEvidence = NonNullable<WorkerEvidenceView['current']>
type Check = ArtifactContract['checks'][number]
const MAX_BYTES = 1024 * 1024

/** FileReader retains the original bytes; the transport sends no filename and host code stores no bytes. */
function encoded(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read artifact'))
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.lastIndexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

function Evidence({ evidence }: { evidence: AssignmentEvidence }) {
  const { t } = usePanel(), { pin, contract, receipts } = evidence
  return <>
    <KeyValues rows={[[t('workerAssignment'), evidence.assignment_id],
      [t('workerStrategy'), pin ? <span className="dt-mono">{pin.generation_id}</span> : t('workerUnbound')],
      ...pin ? [[t('workerRevision'), String(pin.manifest.prompt_revision)],
        [t('workerContext'), <span className="dt-mono">{pin.context_sha256}</span>]] as [string, ReactNode][] : [],
      [t('artifactContract'), contract ? <span className="dt-mono">{contract.id}</span> : t('artifactNotFrozen')]]} />
    {contract && <ul className="dt-plain-list">{contract.checks.map(check => <li key={check.id}>
      <span className="dt-mono">{check.id}</span> · {t(check.kind === 'contains' ? 'artifactContains' : check.kind === 'excludes'
        ? 'artifactExcludes' : 'artifactHash')} · <code>{check.value}</code>
    </li>)}</ul>}
    <p>{t('artifactResult')}: {receipts.length ? t(receipts.at(-1)!.status === 'passed' ? 'artifactPassed' : 'artifactFailed') : t('artifactUnchecked')}</p>
    {receipts.length > 0 && <details><summary>{t('artifactReceipts', { count: receipts.length })}</summary>
      {receipts.slice().reverse().map(receipt => <div key={receipt.id} className="dt-row">
        <KeyValues rows={[[t('artifactResult'), t(receipt.status === 'passed' ? 'artifactPassed' : 'artifactFailed')],
          [t('artifactDigest'), <code>{receipt.artifact_sha256}</code>], [t('artifactBytes'), String(receipt.artifact_bytes)],
          [t('artifactCheckedAt'), <When at={receipt.checked_at} />]]} />
        <ul>{receipt.results.map(result => <li key={result.id}>{result.id}: {t(result.pass ? 'artifactPassed' : 'artifactFailed')}</li>)}</ul>
      </div>)}
    </details>}
  </>
}

function CheckEditor({ id, evidence, reload }: { id: string; evidence: AssignmentEvidence; reload: () => Promise<unknown> }) {
  const { t, call } = usePanel(), { pin, contract } = evidence
  const [checks, setChecks] = useState<Check[]>([{ id: 'check-1', kind: 'contains', value: '' }])
  const [file, setFile] = useState<File>()
  const freeze = useAction(async () => {
    if (!pin) return
    await call('PUT tickets/:id/artifact-contract', { id, body: { assignment_id: evidence.assignment_id,
      generation_id: pin.generation_id, checks } })
  }, { reload })
  const upload = useAction(async () => {
    if (!pin || !contract || !file) return
    if (file.size > MAX_BYTES) throw new Error(t('artifactTooLarge'))
    await call('POST tickets/:id/artifact-check', { id, body: { assignment_id: evidence.assignment_id,
      generation_id: pin.generation_id, contract_id: contract.id, artifact_base64: await encoded(file) } })
    setFile(undefined)
  }, { reload })
  if (!pin) return null
  return <>
    {!contract ? <>
      <Hint>{t('artifactFreezeHint')}</Hint>
      {checks.map((check, index) => <div className="dt-row" key={index}>
        <Input aria-label={t('artifactCheckId', { index: index + 1 })} value={check.id} maxLength={128}
          onChange={event => setChecks(checks.map((item, i) => i === index ? { ...item, id: event.target.value } : item))} />
        <select className="dt-select" aria-label={t('artifactCheckKind', { index: index + 1 })} value={check.kind}
          onChange={event => setChecks(checks.map((item, i) => i === index ? { ...item, kind: event.target.value as Check['kind'] } : item))}>
          <option value="contains">{t('artifactContains')}</option><option value="excludes">{t('artifactExcludes')}</option>
          <option value="sha256">{t('artifactHash')}</option>
        </select>
        <Input aria-label={t('artifactCheckValue', { index: index + 1 })} value={check.value} maxLength={1024}
          onChange={event => setChecks(checks.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
        <Button disabled={checks.length === 1 || freeze.busy} onClick={() => setChecks(checks.filter((_, i) => i !== index))}>{t('artifactRemove')}</Button>
      </div>)}
      <Button disabled={checks.length >= 32 || freeze.busy} onClick={() => {
        let index = 1
        while (checks.some(check => check.id === `check-${index}`)) index++
        setChecks([...checks, { id: `check-${index}`, kind: 'contains', value: '' }])
      }}>{t('artifactAdd')}</Button>
      <ConfirmButton variant="outline" label={t('artifactFreeze')} title={t('artifactFreeze')} message={t('artifactFreezeConfirm')}
        disabled={freeze.busy || checks.some(check => !check.id || !check.value)} onConfirm={async () => { await freeze.run() }} />
    </> : <>
      <label>{t('artifactFile')} <input type="file" disabled={upload.busy} onChange={event => setFile(event.target.files?.[0])} /></label>
      {file && file.size > MAX_BYTES && <Hint>{t('artifactTooLarge')}</Hint>}
      <Button variant="outline" disabled={upload.busy || !file || file.size > MAX_BYTES}
        onClick={() => { void upload.run() }}>{t('artifactVerify')}</Button>
    </>}
  </>
}

export function WorkerEvidence({ id }: { id: string }) {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET tickets/:id/worker-evidence', { id }), [id])
  return <div className="dt-worker-evidence">
    <Hint>{t('workerPinScope')}</Hint>
    <Hint>{t('artifactScope')}</Hint>
    {error || !data ? <LoadState error={error} loading={!data && !error} /> : <>
      {data.current ? <>
        <Evidence evidence={data.current} />
        <CheckEditor key={`${id}:${data.current.assignment_id}:${data.current.pin?.generation_id ?? ''}:${data.current.contract?.id ?? ''}`}
          id={id} evidence={data.current} reload={reload} />
      </> : <Hint>{t('workerUnbound')}</Hint>}
      {data.history.length > 0 && <details><summary>{t('workerHistory')}</summary>
        {data.history.map(item => <div className="dt-row" key={item.assignment_id}><Evidence evidence={item} /></div>)}
      </details>}
    </>}
  </div>
}
