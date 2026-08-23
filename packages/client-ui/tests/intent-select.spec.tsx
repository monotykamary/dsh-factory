// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import type { FactoryRemote } from '../src/client/factory-client.ts'
import { FactoryIntentController } from '../src/client/factory-intake.ts'
import { FactoryIntentSelect } from '../src/client/FactoryIntentSelect.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: keyof typeof en, values?: Record<string, string>) => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, value)
  return text
}) as TranslateNS<'factory'>

describe('Factory New Session intent selector', () => {
  it('offers only Task and Flow at the root and nests the Run later opt-out', () => {
    const api = { snapshot: vi.fn() } as unknown as FactoryRemote
    const controller = new FactoryIntentController(api, () => '/repo')
    render(<FactoryIntentSelect
      controller={controller}
      session={{ blank: true, subagent: null } as never}
      input={{ phase: 'ready' } as never}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: 'New work intent, current Task' })
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /^Session/ })).toBeNull()
    const taskItem = screen.getByRole('menuitem', { name: /^Task/ })
    const check = taskItem.querySelector('.lucide-check')
    const chevron = taskItem.querySelector('.lucide-chevron-right')
    expect(check).not.toBeNull()
    expect(chevron).not.toBeNull()
    expect(check!.compareDocumentPosition(chevron!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    fireEvent.click(taskItem)
    expect(screen.getByRole('menuitem', { name: /^Run immediately/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Run later/ }))

    expect(controller.intent).toEqual({ kind: 'task', run: 'later' })
    expect(screen.getByRole('button', { name: 'New work intent, current Task · Run later' })).toBeTruthy()
  })
})
