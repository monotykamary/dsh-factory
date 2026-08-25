// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import {
  FactoryAttachmentId, FactoryProcessId, FactoryProjectId, FactoryRunId, FactoryTaskId, emptyFactoryDocument,
  type FactorySnapshot, type FactoryTask,
} from 'dsh-factory-protocol'
import { FactoryTaskCard } from '../src/client/FactoryTaskCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const now = '2026-08-24T12:00:00.000Z'
const projectId = FactoryProjectId('project:task-card')
const sessionId = 'session:linked-task'
const t = ((key: keyof typeof en, values?: Record<string, string>) => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, value)
  return text
}) as TranslateNS<'factory'>

function fixture(): { snapshot: FactorySnapshot; task: FactoryTask } {
  const document = emptyFactoryDocument(now)
  document.projects.push({
    id: projectId, title: 'Harness', mainPath: '/repo', settings: { autoTitle: true, lane: { mode: 'isolated' } },
    createdAt: now, updatedAt: now,
  })
  const task: FactoryTask = {
    id: FactoryTaskId('task:linked'), identifier: 'FAC-90', projectId, title: 'Linked Session task',
    description: 'Open the originating chat.', prompt: 'Inspect the linked Session.', status: 'succeeded', priority: 2,
    labels: [], dependencyIds: [], lane: { mode: 'isolated' }, finalizer: false, attachments: [], comments: [],
    createdAt: now, updatedAt: now,
  }
  document.tasks.push(task)
  return {
    task,
    snapshot: { revision: 3, document, agents: [], defaultModel: 'mock:model', generatedAt: now },
  }
}

function renderCard(
  onOpenSession?: () => void,
  configure?: (task: FactoryTask, snapshot: FactorySnapshot) => void,
  disposition: {
    excluded?: ReadonlySet<string>
    settled?: boolean
    archived?: boolean
    onSettle?: () => void
    onArchive?: () => Promise<void>
    onDelete?: (request: { taskId: FactoryTask['id']; expectedRevision?: number }) => Promise<void>
    linked?: boolean
  } = {},
) {
  const { snapshot, task } = fixture()
  configure?.(task, snapshot)
  return render(<FactoryTaskCard
    task={task} snapshot={snapshot} modelChoices={[]} artifactApi={{ artifactMedia: vi.fn(async () => ({ ok: true as const, value: [] })), artifactMediaData: vi.fn() } as never} artifactRefreshToken={snapshot.generatedAt} sessionId={disposition.linked === false ? undefined : sessionId} t={t}
    onBack={vi.fn()} onOpenSession={onOpenSession} onOpenSettings={vi.fn()}
    excludedDependencySessionIds={disposition.excluded ?? new Set()} sessionSettled={disposition.settled ?? false} sessionArchived={disposition.archived ?? false}
    onSettleSession={disposition.onSettle} onArchiveSession={disposition.onArchive}
    onDeleteTask={disposition.onDelete ?? vi.fn(async () => undefined)}
    onUpdate={vi.fn(async () => undefined)} onAction={vi.fn(async () => undefined)}
    onComment={vi.fn(async () => undefined)} onConnect={vi.fn(async () => undefined)}
    onAttach={vi.fn(async () => undefined)}
  />)
}

describe('Factory task Session navigation', () => {
  it('exposes a listed Session id as an accessible link', () => {
    const onOpenSession = vi.fn()
    renderCard(onOpenSession)

    const link = screen.getByRole('button', { name: `Open Session ${sessionId}` })
    expect(link.textContent).toBe(sessionId)
    expect(link.getAttribute('title')).toBe(`Open Session ${sessionId}`)
    fireEvent.click(link)
    expect(onOpenSession).toHaveBeenCalledOnce()
  })

  it('keeps an unavailable Session id visible without a broken link', () => {
    renderCard()

    expect(screen.getByText(sessionId)).toBeTruthy()
    expect(screen.queryByRole('button', { name: `Open Session ${sessionId}` })).toBeNull()
  })

  it('settles and archives the linked Session from task visibility controls', () => {
    const onSettle = vi.fn()
    const onArchive = vi.fn(async () => undefined)
    renderCard(undefined, (task) => { task.status = 'cancelled' }, { onSettle, onArchive })

    expect(screen.queryByRole('button', { name: 'Delete task' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(onSettle).toHaveBeenCalledOnce()
    expect(onArchive).toHaveBeenCalledOnce()
  })

  it('permanently deletes a cancelled task without a linked Session after acknowledgement', async () => {
    const onDelete = vi.fn(async () => undefined)
    renderCard(undefined, (task) => { task.status = 'cancelled' }, { linked: false, onDelete })

    expect(screen.queryByRole('button', { name: 'Settle' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete FAC-90?' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'I understand this task has no Session history to preserve.' }))
    fireEvent.click(confirm)

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith({ taskId: FactoryTaskId('task:linked'), expectedRevision: 3 })
    })
  })

  it('omits terminal and settled tasks from dependency choices', () => {
    const settledSession = 'session:settled-candidate'
    renderCard(undefined, (task, snapshot) => {
      task.status = 'draft'
      const candidate = (suffix: string, status: FactoryTask['status']): FactoryTask => ({
        ...task, id: FactoryTaskId(`task:${suffix}`), identifier: `FAC-${suffix}`, title: suffix, prompt: suffix, status,
      })
      const available = candidate('available', 'queued')
      const failed = candidate('failed', 'failed')
      const complete = candidate('complete', 'succeeded')
      const settled = candidate('settled', 'queued')
      snapshot.document.tasks.push(available, failed, complete, settled)
      snapshot.document.runs.push({
        id: FactoryRunId('run:settled'), taskId: settled.id, origin: 'scheduler', attempt: 1, status: 'succeeded',
        processId: FactoryProcessId('process:settled'), sessionId: settledSession,
        startedAt: now, updatedAt: now, finishedAt: now,
      })
    }, { excluded: new Set([settledSession]) })

    fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }))
    expect(screen.getByText('FAC-available · available')).toBeTruthy()
    expect(screen.queryByText('FAC-failed · failed')).toBeNull()
    expect(screen.queryByText('FAC-complete · complete')).toBeNull()
    expect(screen.queryByText('FAC-settled · settled')).toBeNull()
  })

  it('renders initial screenshots as a compact carousel rail', () => {
    renderCard(undefined, (task) => {
      task.attachments.push(
        { id: FactoryAttachmentId('attachment:first'), name: 'first.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,Zmlyc3Q=' },
        { id: FactoryAttachmentId('attachment:second'), name: 'second.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,c2Vjb25k' },
      )
    })

    const rail = screen.getByRole('group', { name: 'Task images' })
    expect(rail.querySelectorAll('img')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'first.png' }))
    const dialog = screen.getByRole('dialog', { name: 'Original image preview' })
    expect(dialog.textContent).toContain('1 of 2')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(within(dialog).getByRole('img', { name: 'second.png' })).toBeTruthy()
  })
})
