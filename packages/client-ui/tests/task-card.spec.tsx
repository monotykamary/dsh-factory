// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import {
  FactoryAttachmentId, FactoryProjectId, FactoryTaskId, emptyFactoryDocument,
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

function renderCard(onOpenSession?: () => void, configure?: (task: FactoryTask) => void) {
  const { snapshot, task } = fixture()
  configure?.(task)
  return render(<FactoryTaskCard
    task={task} snapshot={snapshot} modelChoices={[]} artifactApi={{ artifactMedia: vi.fn(async () => ({ ok: true as const, value: [] })), artifactMediaData: vi.fn() } as never} artifactRefreshToken={snapshot.generatedAt} sessionId={sessionId} t={t}
    onBack={vi.fn()} onOpenSession={onOpenSession} onOpenSettings={vi.fn()}
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
