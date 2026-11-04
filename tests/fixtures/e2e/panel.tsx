/** Browser entry for the production panel; no fake client API and no test-only production route. */
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/client/app.tsx'
import { en, zh, type DshSuperagentKey } from '../../../src/client/locales.ts'
import type { T } from '../../../src/client/text.ts'
import theme from './theme.css?raw'

const style = document.createElement('style'); style.textContent = theme; document.head.append(style)

const dictionary = new URL(location.href).searchParams.get('lang') === 'zh' ? zh : en
const t: T = ((key: DshSuperagentKey, values?: Record<string, unknown>) => {
  const template = dictionary[key] ?? key
  return values ? template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match) : template
}) as T
createRoot(document.getElementById('root')!).render(<App t={t} deploymentForm={undefined} openSession={async () => {}} />)
