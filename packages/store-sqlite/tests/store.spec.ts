import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@monotykamary/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { FactoryProcessId, FactoryTaskId } from 'dsh-factory-protocol'
import { FactoryRevisionConflictError, SqliteFactoryStore } from '../src/index.ts'

const contexts: Context[] = []
let root: string | undefined

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function stores(): Promise<[SqliteFactoryStore, SqliteFactoryStore]> {
  root = await mkdtemp(join(tmpdir(), 'dsh-factory-store-'))
  const path = join(root, 'factory.sqlite')
  const left = new Context()
  const right = new Context()
  contexts.push(left, right)
  return [new SqliteFactoryStore(left, { path }), new SqliteFactoryStore(right, { path })]
}

describe('SqliteFactoryStore', () => {
  it('commits revisions across processes and rejects stale writers', async () => {
    const [left, right] = await stores()
    const initial = await left.read()
    const committed = await left.mutate(initial.revision, draft => { draft.nextTaskNumber = 2 })
    expect(committed.revision).toBe(1)
    await expect(right.mutate(initial.revision, draft => { draft.nextTaskNumber = 3 })).rejects.toBeInstanceOf(FactoryRevisionConflictError)
    expect((await right.read()).document.nextTaskNumber).toBe(2)
  })

  it('rolls back an invalid graph without advancing the revision', async () => {
    const [store] = await stores()
    await expect(store.mutate(0, draft => {
      draft.tasks.push({
        id: FactoryTaskId('self'), identifier: 'FAC-1', projectId: 'project' as never, title: 'bad', description: '', prompt: '', status: 'queued', priority: 1,
        labels: [], dependencyIds: [FactoryTaskId('self')], lane: { mode: 'isolated' }, finalizer: false, attachments: [], comments: [], createdAt: 'now', updatedAt: 'now',
      })
    })).rejects.toThrow(/depends on itself/)
    expect((await store.read()).revision).toBe(0)
  })

  it('replaces and expires process-owned presence', async () => {
    const [store] = await stores()
    const processId = FactoryProcessId('process:left')
    await store.replaceAgentObservations(processId, [{
      processId, agentId: 'agent:one', sessionId: 'session:one', status: 'idle', origin: 'subagent', delegationDepth: 2, heartbeatAt: '2026-08-22T00:00:00.000Z',
    }])
    expect(await store.readAgentObservations('2026-08-21T00:00:00.000Z')).toEqual([expect.objectContaining({ origin: 'subagent', delegationDepth: 2 })])
    expect(await store.readAgentObservations('2026-08-23T00:00:00.000Z')).toEqual([])
  })

  it('elects one leader and permits takeover only after expiry', async () => {
    const [left, right] = await stores()
    const one = FactoryProcessId('process:one')
    const two = FactoryProcessId('process:two')
    expect((await left.acquireLeader(one, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:10.000Z')).processId).toBe(one)
    expect((await right.acquireLeader(two, '2026-08-22T00:00:05.000Z', '2026-08-22T00:00:15.000Z')).processId).toBe(one)
    expect((await right.acquireLeader(two, '2026-08-22T00:00:11.000Z', '2026-08-22T00:00:21.000Z')).processId).toBe(two)
  })
})
