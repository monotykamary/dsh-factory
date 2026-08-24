// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WorkspaceView } from '@monotykamary/dsh-client-runtime/client'
import {
  FactoryProjectId, emptyFactoryDocument, type FactoryProjectSettings, type FactorySnapshot,
} from 'dsh-factory-protocol'
import { FactorySettings } from '../src/client/FactorySettings.tsx'
import type { FactoryModelChoice } from '../src/client/factory-client.ts'

afterEach(cleanup)

const now = '2026-08-24T12:00:00.000Z'

const choices: readonly FactoryModelChoice[] = [
  { id: 'mock:writer', label: 'Writer · Mock', provider: 'mock', model: 'writer' },
  { id: 'mock:critic', label: 'Critic · Mock', provider: 'mock', model: 'critic' },
]

function workspace(path: string, title: string): WorkspaceView {
  return { path, title } as unknown as WorkspaceView
}

function snapshot(revision: number, overrides: { one?: Partial<FactoryProjectSettings>; two?: Partial<FactoryProjectSettings> } = {}): FactorySnapshot {
  const document = emptyFactoryDocument(now)
  const lane = (settings: Partial<FactoryProjectSettings> | undefined): FactoryProjectSettings['lane'] =>
    ({ mode: 'isolated', ...(settings?.lane ?? {}) })
  document.projects.push({
    id: FactoryProjectId('project:one'), title: 'Harness', mainPath: '/repo',
    settings: { model: 'mock:writer', autoTitle: true, ...overrides.one, lane: lane(overrides.one) },
    createdAt: now, updatedAt: now,
  })
  document.projects.push({
    id: FactoryProjectId('project:two'), title: 'Docs', mainPath: '/docs',
    settings: { model: 'mock:writer', autoTitle: true, ...overrides.two, lane: lane(overrides.two) },
    createdAt: now, updatedAt: now,
  })
  return { revision, document, agents: [], defaultModel: 'mock:writer', generatedAt: now }
}

/** Repeat a polling snapshot read: identical content under fresh object identity. */
function poll(value: FactorySnapshot): FactorySnapshot {
  const copy = structuredClone(value)
  copy.generatedAt = '2026-08-24T12:02:00.000Z'
  return copy
}

function element(value: FactorySnapshot, props: { initialPath?: string; onSave?: (request: never) => Promise<void> } = {}) {
  return (
    <FactorySettings
      snapshot={value}
      workspaces={[workspace('/repo', 'Harness'), workspace('/docs', 'Docs')]}
      choices={choices}
      onSave={vi.fn(async () => undefined)}
      {...props}
    />
  )
}

describe('Factory settings under polling refreshes', () => {
  it('keeps unsaved settings edits across polling refreshes', () => {
    const view = render(element(snapshot(1)))

    fireEvent.change(screen.getByPlaceholderText('pnpm install'), { target: { value: './scripts/setup.sh' } })
    fireEvent.change(screen.getByPlaceholderText('Workspace default branch'), { target: { value: 'release/2.x' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Generate titles and descriptions/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Workspace task model' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Critic · Mock/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Default checkout' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Current checkout/ }))

    view.rerender(element(poll(snapshot(1))))

    expect((screen.getByPlaceholderText('pnpm install') as HTMLTextAreaElement).value).toBe('./scripts/setup.sh')
    expect((screen.getByPlaceholderText('Workspace default branch') as HTMLInputElement).value).toBe('release/2.x')
    expect((screen.getByRole('checkbox', { name: /Generate titles and descriptions/ }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Workspace task model' }).textContent).toContain('Critic · Mock')
    expect(screen.getByRole('button', { name: 'Default checkout' }).textContent).toContain('Current checkout')
  })

  it('groups advanced metadata fields on one spaced content track', () => {
    render(element(snapshot(1)))
    fireEvent.click(screen.getByText('Advanced metadata prompts'))

    const title = screen.getByLabelText('Task title instruction').closest('label')
    const description = screen.getByLabelText('Task description instruction').closest('label')
    expect(title?.parentElement).toBe(description?.parentElement)
    expect(title?.parentElement?.children).toHaveLength(4)
  })

  it('reseeds only when persisted settings content changes', () => {
    const view = render(element(snapshot(1)))
    expect(screen.getByRole('button', { name: 'Workspace task model' }).textContent).toContain('Writer · Mock')

    view.rerender(element(poll(snapshot(2))))
    expect(screen.getByRole('button', { name: 'Workspace task model' }).textContent).toContain('Writer · Mock')
    expect((screen.getByPlaceholderText('pnpm install') as HTMLTextAreaElement).value).toBe('')

    view.rerender(element(snapshot(3, { one: { model: 'mock:critic', setupCommand: 'make setup' } })))
    expect(screen.getByRole('button', { name: 'Workspace task model' }).textContent).toContain('Critic · Mock')
    expect((screen.getByPlaceholderText('pnpm install') as HTMLTextAreaElement).value).toBe('make setup')
  })

  it('applies a targeted workspace once and keeps later choices across polling refreshes', () => {
    const view = render(element(snapshot(1), { initialPath: '/repo' }))
    expect(screen.getByRole('button', { name: 'Settings workspace' }).textContent).toContain('Harness')

    fireEvent.click(screen.getByRole('button', { name: 'Settings workspace' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Docs/ }))
    expect(screen.getByRole('button', { name: 'Settings workspace' }).textContent).toContain('Docs')

    view.rerender(element(poll(snapshot(1)), { initialPath: '/repo' }))
    expect(screen.getByRole('button', { name: 'Settings workspace' }).textContent).toContain('Docs')
  })
})
