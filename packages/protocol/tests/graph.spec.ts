import { describe, expect, it } from 'vitest'
import {
  FactoryFlowId, FactoryMetadataGenerationId, FactoryProcessId, FactoryProjectId, FactoryRunId, FactoryTaskId,
  deriveFlowStatus, emptyFactoryDocument, factoryRecurringCron, factoryRecurringLabel, isTaskReady, orderTaskGraph,
  parseFactoryDocument, readyTasks, validateTaskGraph, type FactoryTask,
} from '../src/index.ts'

const now = '2026-08-22T00:00:00.000Z'
const projectId = FactoryProjectId('project:one')

function task(id: string, overrides: Partial<FactoryTask> = {}): FactoryTask {
  return {
    id: FactoryTaskId(id), identifier: id.toUpperCase(), projectId, title: id, description: '', prompt: id,
    status: 'queued', priority: 1, labels: [], dependencyIds: [], lane: { mode: 'isolated' }, finalizer: false,
    attachments: [], comments: [], createdAt: now, updatedAt: now, ...overrides,
  }
}

describe('Factory graph', () => {
  it('orders ready tasks by Linear priority and leaves no-priority work last', () => {
    const complete = task('one', { status: 'succeeded' })
    const high = task('two', { dependencyIds: [complete.id], priority: 2 })
    const none = task('three', { priority: 0 })
    const blocked = task('four', { dependencyIds: [high.id] })
    const urgent = task('five', { priority: 1 })
    const document = { ...emptyFactoryDocument(), tasks: [complete, high, none, blocked, urgent] }
    expect(readyTasks(document).map(value => value.id)).toEqual([urgent.id, high.id, none.id])
  })

  it('orders shuffled task nodes from roots through parallel branches to their join', () => {
    const root = task('root')
    const left = task('left', { dependencyIds: [root.id] })
    const right = task('right', { dependencyIds: [root.id] })
    const join = task('join', { dependencyIds: [left.id, right.id] })
    expect(orderTaskGraph([join, right, root, left]).map(value => value.id)).toEqual([root.id, left.id, right.id, join.id])
  })

  it('runs finalizers after ordinary nodes settle and applies success policy', () => {
    const flowId = FactoryFlowId('flow:one')
    const failed = task('implementation', { flowId, status: 'failed' })
    const always = task('cleanup', { flowId, finalizer: true, finalizerPolicy: 'always' })
    const publish = task('publish', { flowId, finalizer: true, finalizerPolicy: 'success' })
    const tasks = new Map([failed, always, publish].map(value => [value.id, value]))
    expect(isTaskReady(always, tasks)).toBe(true)
    expect(isTaskReady(publish, tasks)).toBe(false)
    expect(deriveFlowStatus([...tasks.values()])).toBe('failed')
  })

  it('derives Scheduled flows and compiles every friendly recurring cadence', () => {
    expect(deriveFlowStatus([task('scheduled', { status: 'scheduled' })])).toBe('scheduled')
    expect(factoryRecurringCron({ kind: 'hourly', minute: 15 })).toBe('15 * * * *')
    expect(factoryRecurringCron({ kind: 'daily', hour: 9, minute: 30 })).toBe('30 9 * * *')
    expect(factoryRecurringCron({ kind: 'weekdays', hour: 8, minute: 0 })).toBe('0 8 * * 1-5')
    expect(factoryRecurringCron({ kind: 'weekly', weekdays: [5, 1, 1], hour: 10, minute: 5 })).toBe('5 10 * * 1,5')
    expect(factoryRecurringCron({ kind: 'monthly', dayOfMonth: 12, hour: 7, minute: 45 })).toBe('45 7 12 * *')
    expect(factoryRecurringLabel({ kind: 'cron', expression: '*/15 * * * *' })).toBe('Cron: */15 * * * *')
  })

  it('accepts valid output mutations and rejects inconsistent durable receipts', () => {
    const document = emptyFactoryDocument()
    document.tasks.push(task('one', {
      status: 'succeeded',
      output: {
        summary: 'done', artifacts: [], completedAt: now,
        mutations: [{
          commitOrder: 0, path: 'src/one.ts', operation: 'create', additions: 1, deletions: 0,
          beforeSha256: null, afterSha256: 'a'.repeat(64),
          diffs: [{ path: 'src/one.ts', oldText: null, newText: 'one' }],
        }],
      },
    }))
    expect(parseFactoryDocument(document).tasks[0]?.output?.mutations[0]?.path).toBe('src/one.ts')
    const malformed = structuredClone(document)
    malformed.tasks[0]!.output!.mutations[0]!.afterSha256 = 'short'
    expect(() => parseFactoryDocument(malformed)).toThrow()
    const contradictory = structuredClone(document)
    contradictory.tasks[0]!.output!.mutations[0]!.diffs[0]!.path = 'src/other.ts'
    expect(() => parseFactoryDocument(contradictory)).toThrow(/hunk path/u)
    const miscounted = structuredClone(document)
    miscounted.tasks[0]!.output!.mutations[0]!.additions = 2
    expect(() => parseFactoryDocument(miscounted)).toThrow(/line totals/u)
    const duplicated = structuredClone(document)
    duplicated.tasks[0]!.output!.mutations.push(structuredClone(duplicated.tasks[0]!.output!.mutations[0]!))
    expect(() => parseFactoryDocument(duplicated)).toThrow(/strictly increasing/u)
  })

  it('requires complete workspace settings and exact metadata receipts in durable documents', () => {
    const document = emptyFactoryDocument()
    document.projects.push({
      id: projectId, title: 'Workspace', mainPath: '/workspace',
      settings: {
        model: 'mock:task', titleModel: 'mock:title', autoTitle: true,
        titlePrompt: 'Name the concrete outcome.', descriptionPrompt: 'Summarize constraints.',
        lane: { mode: 'isolated', baseRef: 'origin/main' }, setupCommand: 'pnpm install',
      },
      createdAt: now, updatedAt: now,
    })
    document.metadataGenerations.push({
      id: FactoryMetadataGenerationId('metadata:one'), projectId,
      target: { kind: 'task', id: FactoryTaskId('task:metadata') }, status: 'succeeded',
      route: { provider: 'mock', model: 'title' }, system: 'Generate metadata.', input: 'Implement the task.', maxTokens: 160,
      output: '{"title":"Task","description":"Description"}', createdAt: now, updatedAt: now,
    })
    expect(parseFactoryDocument(document).projects[0]?.settings).toEqual(document.projects[0]?.settings)

    const obsolete = structuredClone(document) as unknown as { projects: Array<Record<string, unknown>> }
    delete obsolete.projects[0]?.settings
    obsolete.projects[0]!.setupCommand = 'pnpm install'
    expect(() => parseFactoryDocument(obsolete)).toThrow()
    const incompleteReceipt = structuredClone(document)
    incompleteReceipt.metadataGenerations[0]!.route.provider = ''
    expect(() => parseFactoryDocument(incompleteReceipt)).toThrow()
  })

  it('retains non-empty New Session intake identity and rejects malformed durable values', () => {
    const document = emptyFactoryDocument()
    document.tasks.push(task('intake', { intakeSessionId: 'session:blank' }))
    expect(parseFactoryDocument(document).tasks[0]?.intakeSessionId).toBe('session:blank')
    const malformed = structuredClone(document) as unknown as { tasks: Array<Record<string, unknown>> }
    malformed.tasks[0]!.intakeSessionId = ''
    expect(() => parseFactoryDocument(malformed)).toThrow()
  })

  it('parses immutable recurring Triage run output and review state', () => {
    const document = emptyFactoryDocument()
    const recurring = task('recurring', {
      status: 'scheduled',
      automation: { enabled: true, trigger: { kind: 'recurring', schedule: { kind: 'daily', hour: 9, minute: 0 } }, nextRunAt: '2026-08-23T09:00:00.000Z' },
    })
    document.tasks.push(recurring)
    document.runs.push({
      id: FactoryRunId('run:one'), taskId: recurring.id, origin: 'scheduler', attempt: 1, status: 'succeeded',
      processId: FactoryProcessId('process:one'), schedule: { kind: 'daily', hour: 9, minute: 0 },
      startedAt: now, updatedAt: now, finishedAt: now, reviewedAt: now,
      output: { summary: 'Reviewed changes', artifacts: [], mutations: [], completedAt: now },
    })
    expect(parseFactoryDocument(document).runs[0]).toMatchObject({ reviewedAt: now, schedule: { kind: 'daily' }, output: { summary: 'Reviewed changes' } })
  })

  it('enforces one inbox and exact task membership per project while rejecting removed pattern fields', () => {
    const document = emptyFactoryDocument()
    const inboxTask = task('inbox', { flowId: FactoryFlowId('flow:inbox') })
    document.tasks.push(inboxTask)
    document.flows.push({
      id: FactoryFlowId('flow:inbox'), projectId, kind: 'inbox', title: 'Emerging work', description: '',
      taskIds: [inboxTask.id], status: 'queued', createdAt: now, updatedAt: now,
    })
    expect(validateTaskGraph(document)).toEqual([])

    const malformed = structuredClone(document)
    malformed.flows.push({ ...malformed.flows[0]!, id: FactoryFlowId('flow:duplicate') })
    malformed.flows[0]!.taskIds = []
    expect(validateTaskGraph(malformed).map(issue => issue.code)).toEqual(expect.arrayContaining(['duplicate-inbox', 'flow-membership']))
    expect(() => parseFactoryDocument({ ...document, patterns: [] })).toThrow()
  })

  it('reports cycles, invalid finalizer edges, missing nodes, and cross-project edges', () => {
    const left = task('left', { dependencyIds: [FactoryTaskId('right')] })
    const right = task('right', { dependencyIds: [left.id], finalizer: true })
    const cross = task('cross', { projectId: FactoryProjectId('project:two'), dependencyIds: [left.id] })
    const missing = task('missing', { dependencyIds: [FactoryTaskId('absent')] })
    const codes = validateTaskGraph({ ...emptyFactoryDocument(), tasks: [left, right, cross, missing] }).map(issue => issue.code)
    expect(codes).toEqual(expect.arrayContaining(['cycle', 'finalizer-dependency', 'cross-project', 'missing-dependency']))
  })
})
