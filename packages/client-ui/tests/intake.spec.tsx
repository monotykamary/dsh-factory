import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@monotykamary/dsh-client-runtime/client'
import {
  FactoryFlowId, FactoryProcessId, FactoryProjectId, FactoryRunId, FactoryTaskId,
  emptyFactoryDocument, type FactorySnapshot,
} from 'dsh-factory-protocol'
import type { FactoryRemote } from '../src/client/factory-client.ts'
import { FactoryIntentController, FactoryNavigation, factorySubmissionMiddleware } from '../src/client/factory-intake.ts'

const sessionId = 'session:intake' as SessionId
const projectId = FactoryProjectId('project:one')
const flowId = FactoryFlowId('flow:one')
const taskId = FactoryTaskId('task:one')
const runId = FactoryRunId('run:one')

function snapshot(): FactorySnapshot {
  const document = emptyFactoryDocument('2026-08-24T00:00:00.000Z')
  document.projects.push({
    id: projectId, title: 'Harness', mainPath: '/repo', settings: { autoTitle: true, lane: { mode: 'isolated' } },
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
  })
  document.flows.push({
    id: flowId, projectId, kind: 'standard', title: 'Release flow', description: '', taskIds: [taskId], status: 'waiting',
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
  })
  document.tasks.push({
    id: taskId, identifier: 'FAC-1', projectId, flowId, title: 'Inspect workspace', description: '', prompt: 'Inspect workspace',
    status: 'waiting', priority: 3, labels: [], dependencyIds: [], lane: { mode: 'current' }, finalizer: false,
    activeRunId: runId, attachments: [], comments: [], createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
  })
  document.runs.push({
    id: runId, taskId, origin: 'observed', attempt: 1, status: 'waiting', processId: FactoryProcessId('process:one'),
    sessionId, startedAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
  })
  return { revision: 1, document, agents: [], defaultModel: 'mock:model', generatedAt: '2026-08-24T00:00:00.000Z' }
}

function api(value = snapshot()) {
  return {
    snapshot: vi.fn(() => Promise.resolve({ ok: true as const, value })),
    intakeSession: vi.fn(() => Promise.resolve({ ok: true as const, value: { taskId, snapshot: value } })),
  } as unknown as FactoryRemote
}

describe('Factory New Session intake', () => {
  it('loads only nonterminal named flows from the current workspace', async () => {
    const value = snapshot()
    value.document.flows.push({
      id: FactoryFlowId('flow:done'), projectId, kind: 'standard', title: 'Finished', description: '', taskIds: [], status: 'succeeded',
      createdAt: value.generatedAt, updatedAt: value.generatedAt,
    })
    const controller = new FactoryIntentController(api(value), () => '/repo')
    controller.select({ kind: 'task', run: 'later' })

    await controller.load()

    expect(controller.store.getSnapshot()).toEqual({
      intent: { kind: 'task', run: 'later' }, loading: false,
      flows: [{ id: flowId, title: 'Release flow', status: 'waiting' }],
    })
  })

  it('runs Task prompts through the ordinary Session path for automatic Emerging-work capture', async () => {
    const remote = api()
    const controller = new FactoryIntentController(remote, () => '/repo')
    const navigation = new FactoryNavigation(vi.fn())
    const middleware = factorySubmissionMiddleware({ api: remote, controllerFor: () => controller, navigation })
    const next = vi.fn(() => Promise.resolve({ kind: 'success' as const }))

    await expect(middleware.submit({ sessionId, text: 'Hello', images: [], mode: 'queue', signal: new AbortController().signal }, next)).resolves.toEqual({ kind: 'success' })
    expect(next).toHaveBeenCalledOnce()
    expect(remote.intakeSession).not.toHaveBeenCalled()
  })

  it('consumes a staged task, then resets and opens its draft card without prompting the Session', async () => {
    const remote = api()
    const controller = new FactoryIntentController(remote, () => '/repo')
    controller.select({ kind: 'task', run: 'later' })
    const openSurface = vi.fn()
    const navigation = new FactoryNavigation(openSurface)
    const middleware = factorySubmissionMiddleware({ api: remote, controllerFor: () => controller, navigation })

    const next = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
    await expect(middleware.submit({ sessionId, text: 'Inspect workspace', images: [], mode: 'queue', signal: new AbortController().signal }, next)).resolves.toEqual({ kind: 'success' })
    expect(remote.intakeSession).toHaveBeenCalledWith({ sessionId, prompt: 'Inspect workspace', attachments: [], destination: 'task' })
    expect(next).not.toHaveBeenCalled()
    expect(controller.intent).toEqual({ kind: 'task', run: 'now' })
    expect(navigation.store.getSnapshot()).toEqual({ taskId })
    expect(openSurface).toHaveBeenCalledOnce()
  })

  it('retains a nuanced flow selection when Factory intake fails', async () => {
    const remote = api()
    vi.mocked(remote.intakeSession).mockResolvedValueOnce({ ok: false, error: { code: 'remote-error', message: 'intake failed', details: {} } } as never)
    const controller = new FactoryIntentController(remote, () => '/repo')
    controller.select({ kind: 'flow', flowId, flowTitle: 'Release flow', placement: 'finalizer' })
    const openSurface = vi.fn()
    const navigation = new FactoryNavigation(openSurface)
    const middleware = factorySubmissionMiddleware({ api: remote, controllerFor: () => controller, navigation })

    const next = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
    await expect(middleware.submit({ sessionId, text: 'Clean up', images: [], mode: 'queue', signal: new AbortController().signal }, next)).rejects.toThrow('intake failed')
    expect(remote.intakeSession).toHaveBeenCalledWith({
      sessionId, prompt: 'Clean up', attachments: [], destination: 'flow', flowId, placement: 'finalizer',
    })
    expect(next).not.toHaveBeenCalled()
    expect(controller.intent).toEqual({ kind: 'flow', flowId, flowTitle: 'Release flow', placement: 'finalizer' })
    expect(openSurface).not.toHaveBeenCalled()
  })
})
