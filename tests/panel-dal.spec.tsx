// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, click, text, at } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
afterEach(() => { vi.restoreAllMocks() })

it('separates ready reports from verification and runtime assurance in both languages', async () => {
  server.ticketDetails.t1!.assignments[0]!.report!.state = 'ready'
  at({ page: 'execution', id: 't1' })
  await mount()
  const evidence = () => [...document.querySelectorAll('section')].find(section => section.textContent?.includes(zh.dalEvidence)
    || section.textContent?.includes(en.dalEvidence))!.textContent!
  expect(evidence()).toContain(zh['report.ready'])
  expect(evidence()).toContain(zh.dalUnverified)
  expect(evidence()).toContain(zh.dalUnattested)
  expect(evidence()).toContain(zh.dalBoundary)
  await remount(en)
  expect(evidence()).toContain(en['report.ready'])
  expect(evidence()).toContain(en.dalVerification)
  expect(evidence()).toContain(en.dalUnverified)
  expect(evidence()).toContain(en.dalBoundary)
  expect(server.requests.some(request => request.path.endsWith('/dal-observation'))).toBe(false)
})

it('downloads a versioned observation only on request without invoking a mutation', async () => {
  const create = vi.fn((_blob: Blob) => 'blob:dal-fixture'), revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
  const downloaded: { name: string; url: string }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloaded.push({ name: this.download, url: this.href })
  })
  at({ page: 'execution', id: 't1' })
  await mount(en)
  await click(en.dalDownload)
  expect(server.requests.filter(request => request.path.endsWith('/dal-observation')))
    .toEqual([{ path: 'tickets/t1/dal-observation', method: 'GET' }])
  expect(server.requests.some(request => request.method !== 'GET')).toBe(false)
  expect(create).toHaveBeenCalledOnce()
  expect(create.mock.calls[0]![0]).toBeInstanceOf(Blob)
  expect(downloaded).toEqual([{ name: expect.stringMatching(/^obs-[a-f0-9]{64}\.json$/), url: 'blob:dal-fixture' }])
  expect(revoke).toHaveBeenCalledWith('blob:dal-fixture')
  expect(text()).toContain(en.dalUnverified)
})

it('reports an export failure without claiming verification or disabling ticket actions', async () => {
  at({ page: 'execution', id: 't1' })
  await mount(en)
  server.down = true
  await click(en.dalDownload)
  expect(document.querySelector('[role="status"]')?.textContent ?? text()).toContain(en.hostNotRunning)
  expect(text()).toContain(en.dalUnverified)
  expect([...document.querySelectorAll('button')].find(button => button.textContent === en.dalDownload)?.disabled).toBe(false)
  server.down = false
  await click(en.stop)
  await click(en.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toBe(true)
})
