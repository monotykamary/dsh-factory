// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import {
  FactoryProcessId, FactoryProjectId, FactoryRunId, FactoryTaskId, emptyFactoryDocument,
  type FactoryRun, type FactorySnapshot, type FactoryTask,
} from 'dsh-factory-protocol'
import { FactoryTriage } from '../src/client/FactoryTriage.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const now = '2026-08-24T12:00:00.000Z'
const projectId = FactoryProjectId('project:triage')
const t = ((key: keyof typeof en) => en[key]) as TranslateNS<'factory'>

function task(id: string, title: string): FactoryTask {
  return {
    id: FactoryTaskId(id), identifier: id.toUpperCase(), projectId, title, description: '', prompt: title,
    status: 'succeeded', priority: 3, labels: [], dependencyIds: [], lane: { mode: 'isolated' }, finalizer: false,
    attachments: [], comments: [], createdAt: now, updatedAt: now,
  }
}

function run(id: string, value: FactoryTask, overrides: Partial<FactoryRun> = {}): FactoryRun {
  return {
    id: FactoryRunId(id), taskId: value.id, origin: 'scheduler', attempt: 1, status: 'succeeded',
    processId: FactoryProcessId('process:triage'), startedAt: now, updatedAt: now, finishedAt: now,
    output: { summary: `${value.title} complete`, artifacts: [], mutations: [] },
    ...overrides,
  }
}

function snapshot(): FactorySnapshot {
  const document = emptyFactoryDocument(now)
  document.projects.push({
    id: projectId, title: 'Harness', mainPath: '/repo', settings: { autoTitle: true, lane: { mode: 'isolated' } },
    createdAt: now, updatedAt: now,
  })
  const regular = task('fac-regular', 'Regular implementation')
  const observed = task('fac-observed', 'Observed investigation')
  const recurring = task('fac-recurring', 'Daily review')
  document.tasks.push(regular, observed, recurring)
  document.runs.push(
    run('run:regular', regular),
    run('run:observed', observed, { origin: 'observed' }),
    run('run:recurring', recurring, { schedule: { kind: 'weekdays', hour: 9, minute: 0 } }),
  )
  return { revision: 3, document, agents: [], defaultModel: 'mock:model', generatedAt: now }
}

describe('Factory Triage', () => {
  it('reviews regular, observed, and recurring terminal runs in one inbox', async () => {
    const onReview = vi.fn(() => Promise.resolve())
    render(<FactoryTriage snapshot={snapshot()} api={{ artifactMedia: vi.fn(async () => ({ ok: true as const, value: [] })), artifactMediaData: vi.fn() } as never} t={t} onOpenTask={vi.fn()} onReview={onReview} />)

    expect(screen.getByText('Regular implementation', { selector: 'strong' })).toBeTruthy()
    expect(screen.getByText('Observed investigation', { selector: 'strong' })).toBeTruthy()
    expect(screen.getByText('Daily review', { selector: 'strong' })).toBeTruthy()
    expect(screen.getByText(/Regular task/)).toBeTruthy()
    expect(screen.getAllByText(/Observed Session/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Weekdays at 9:00 AM/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    await waitFor(() => {
      expect(onReview).toHaveBeenCalledWith([
        FactoryRunId('run:regular'), FactoryRunId('run:observed'), FactoryRunId('run:recurring'),
      ])
    })
  })
})
