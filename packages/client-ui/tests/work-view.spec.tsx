// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@monotykamary/dsh-client-runtime/client'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import type { SessionDispositionSnapshot } from '@monotykamary/dsh-client-ui-workspace/client'
import {
  FactoryFlowId, FactoryProcessId, FactoryProjectId, FactoryRunId, FactoryTaskId,
  emptyFactoryDocument, type FactoryFlowKind, type FactorySnapshot,
} from 'dsh-factory-protocol'
import { WorkView } from '../src/client/FactoryApp.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const now = '2026-08-24T12:00:00.000Z'
const projectId = FactoryProjectId('project:work-view')
const t = ((key: keyof typeof en, values?: Record<string, string | number>) => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}) as TranslateNS<'factory'>

function fixture(entries: readonly { suffix: string; sessionId: SessionId; kind?: FactoryFlowKind }[]): FactorySnapshot {
  const document = emptyFactoryDocument(now)
  document.projects.push({
    id: projectId, title: 'Harness', mainPath: '/repo', settings: { autoTitle: true, lane: { mode: 'isolated' } },
    createdAt: now, updatedAt: now,
  })
  for (const [index, entry] of entries.entries()) {
    const flowId = FactoryFlowId(`flow:${entry.suffix}`)
    const taskId = FactoryTaskId(`task:${entry.suffix}`)
    document.flows.push({
      id: flowId, projectId, kind: entry.kind ?? 'inbox', title: `${entry.suffix} flow`, description: '', taskIds: [taskId], status: 'waiting',
      createdAt: now, updatedAt: now,
    })
    document.tasks.push({
      id: taskId, identifier: `FAC-${String(index + 1)}`, projectId, flowId, title: `${entry.suffix} task`, description: '', prompt: `${entry.suffix} prompt`,
      status: 'waiting', priority: 3, labels: [], dependencyIds: [], lane: { mode: 'current' }, finalizer: false,
      attachments: [], comments: [], createdAt: now, updatedAt: now,
    })
    document.runs.push({
      id: FactoryRunId(`run:${entry.suffix}`), taskId, origin: 'observed', attempt: 1, status: 'waiting', processId: FactoryProcessId(`process:${entry.suffix}`),
      sessionId: entry.sessionId, startedAt: now, updatedAt: now,
    })
  }
  return { revision: 1, document, agents: [], defaultModel: 'mock:model', generatedAt: now }
}

function renderWork(snapshot: FactorySnapshot, options: {
  settled?: readonly SessionId[]
  snoozed?: SessionDispositionSnapshot['snoozedUntilBySession']
  archived?: readonly SessionId[]
  onUnsettle?: (sessionId: SessionId) => void
} = {}) {
  return render(<WorkView
    snapshot={snapshot} query="" filter="all" t={t}
    settledSessionIds={options.settled ?? []}
    snoozedUntilBySession={options.snoozed ?? {}}
    archivedSessionIds={options.archived ?? []}
    onOpen={vi.fn()} onPriority={vi.fn(async () => undefined)} onStatus={vi.fn(async () => undefined)}
    onStartFlow={vi.fn(async () => undefined)} onUnsettle={options.onUnsettle ?? vi.fn()}
  />)
}

describe('Factory Emerging Work disposition', () => {
  it('moves a settled observed inbox task into collapsed history and restores it through Un-settle', () => {
    const sessionId = 'session:settled' as SessionId
    const onUnsettle = vi.fn()
    renderWork(fixture([{ suffix: 'settled', sessionId }]), { settled: [sessionId], onUnsettle })

    expect(screen.queryByTestId('factory-task-FAC-1')).toBeNull()
    const shelf = screen.getByTestId('factory-settled-emerging')
    const toggle = screen.getByRole('button', { name: /Settled emerging work/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(shelf.textContent).toContain('Sessions · 1')

    fireEvent.click(toggle)
    expect(screen.getByTestId('factory-task-FAC-1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Un-settle settled task' }))
    expect(onUnsettle).toHaveBeenCalledWith(sessionId)
  })


  it('uses the latest observed run when an inbox task has multiple Session links', () => {
    const earlier = 'session:earlier' as SessionId
    const later = 'session:later' as SessionId
    const value = fixture([{ suffix: 'latest', sessionId: earlier }])
    const task = value.document.tasks[0]
    if (task === undefined) throw new Error('fixture task missing')
    value.document.runs.push({
      id: FactoryRunId('run:latest-2'), taskId: task.id, origin: 'observed', attempt: 2, status: 'waiting',
      processId: FactoryProcessId('process:latest-2'), sessionId: later,
      startedAt: '2026-08-24T12:01:00.000Z', updatedAt: '2026-08-24T12:01:00.000Z',
    })

    renderWork(value, { settled: [earlier] })
    expect(screen.getByTestId('factory-task-FAC-1')).toBeTruthy()
    cleanup()
    renderWork(value, { settled: [later] })
    expect(screen.queryByTestId('factory-task-FAC-1')).toBeNull()
    expect(screen.getByTestId('factory-settled-emerging')).toBeTruthy()
  })

  it('hides snoozed and archived observed inbox tasks from active work and settled history', () => {
    const snoozed = 'session:snoozed' as SessionId
    const archived = 'session:archived' as SessionId
    renderWork(fixture([
      { suffix: 'snoozed', sessionId: snoozed },
      { suffix: 'archived', sessionId: archived },
    ]), {
      settled: [snoozed, archived],
      snoozed: { [snoozed]: Date.now() + 60_000 },
      archived: [archived],
    })

    expect(screen.queryByTestId('factory-task-FAC-1')).toBeNull()
    expect(screen.queryByTestId('factory-task-FAC-2')).toBeNull()
    expect(screen.queryByTestId('factory-settled-emerging')).toBeNull()
    expect(screen.getByText('No Factory work matches this view.')).toBeTruthy()
  })

  it('keeps named-flow tasks visible when their linked Session is settled, snoozed, and archived', () => {
    const sessionId = 'session:named-flow' as SessionId
    renderWork(fixture([{ suffix: 'named', sessionId, kind: 'standard' }]), {
      settled: [sessionId], snoozed: { [sessionId]: Date.now() + 60_000 }, archived: [sessionId],
    })

    expect(screen.getByTestId('factory-task-FAC-1')).toBeTruthy()
    expect(screen.queryByTestId('factory-settled-emerging')).toBeNull()
  })
})
