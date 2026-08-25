import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry, { type Agent } from '@monotykamary/dsh-agent'
import { Context } from '@monotykamary/cordis'
import WorktreeRegistry, { type WorktreeProvider } from '@monotykamary/dsh-worktree'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FactoryArtifactMediaId, FactoryIntakeId, FactoryProcessId } from 'dsh-factory-protocol'
import { SqliteFactoryStore } from 'dsh-factory-store-sqlite'
import { FactoryDomain } from 'dsh-factory-domain'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function fixture(titleGenerationEnabled = false, metadataOutput = '{"title":"Generated task title","description":"Generated task description."}') {
  root = await mkdtemp(join(tmpdir(), 'dsh-factory-domain-'))
  const projectPath = join(root, 'repo')
  await import('node:fs/promises').then(fs => fs.mkdir(projectPath))
  ctx = new Context()
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'task-model' }) } as never)
  ctx.provide('sessionTitle', { get: () => undefined } as never)
  ctx.provide('llm', {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: metadataOutput }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } as never)
  new AgentRegistry(ctx)
  const worktrees = new WorktreeRegistry(ctx, { provider: 'fixture' })
  const provider: WorktreeProvider = {
    name: 'fixture',
    locate: request => Promise.resolve({ id: 'repository:fixture' as never, provider: request.provider, name: 'Fixture', mainPath: projectPath }),
    list: () => Promise.resolve([{ id: 'checkout:main' as never, repositoryId: 'repository:fixture' as never, path: projectPath, branch: 'main', head: 'abc', kind: 'main', managed: false, current: true, locked: false, prunable: false, activeSessionIds: [] }]),
    create: () => Promise.reject(new Error('not used by domain tests')),
    remove: () => Promise.reject(new Error('not used by domain tests')),
    sweep: () => Promise.resolve({ removed: [] }),
  }
  worktrees.registerProvider(provider)
  const store = new SqliteFactoryStore(ctx, { path: join(root, 'factory.sqlite') })
  const domain = new FactoryDomain(ctx, { heartbeatMs: 60_000, presenceTtlMs: 60_000, titleGenerationEnabled })
  return { context: ctx, projectPath, store, domain }
}

describe('FactoryDomain', () => {
  it('creates canonical projects and rejects stale browser revisions', async () => {
    const { domain, projectPath } = await fixture()
    const created = await domain.createTask({ projectPath, title: 'Implement', prompt: 'Change code', model: 'mock:task-model', enqueue: true, expectedRevision: 0 })
    expect(created.document.projects[0]).toMatchObject({ title: 'Fixture', mainPath: projectPath, repositoryId: 'repository:fixture', defaultRef: 'main' })
    expect(created.document.tasks[0]).toMatchObject({ identifier: 'FAC-1', status: 'queued', lane: { mode: 'isolated' }, model: 'mock:task-model' })
    const task = created.document.tasks[0]
    if (task === undefined) throw new Error('created task is missing')
    const commented = await domain.comment({
      taskId: task.id, body: '', expectedRevision: created.revision,
      attachments: [{ name: 'pasted.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }],
    })
    expect(commented.document.tasks[0]?.comments[0]).toMatchObject({
      body: '', attachments: [expect.objectContaining({ name: 'pasted.png', mediaType: 'image/png' })],
    })
    await expect(domain.createTask({ projectPath, title: 'Stale', prompt: 'No', expectedRevision: 0 })).rejects.toThrow(/revision conflict/)
  })

  it('automatically sinks a published live Agent without a browser mutation', async () => {
    const { context, domain, projectPath } = await fixture()
    const agent = {
      id: 'session:auto-inbox', status: 'idle', session: { header: { cwd: projectPath }, events: [{ type: 'user/message' }] },
      options: { provider: 'mock', model: 'auto-model' },
    } as unknown as Agent
    const list = vi.spyOn(context.agents, 'list').mockReturnValue([agent])
    context.emit('agent/created', { agent })
    const deadline = Date.now() + 2_000
    let stored = await domain.readStore()
    while (stored.document.flows.every(flow => flow.kind !== 'inbox')) {
      if (Date.now() >= deadline) throw new Error('automatic inbox synchronization timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
      stored = await domain.readStore()
    }
    expect(stored.document.flows[0]).toMatchObject({ kind: 'inbox', title: 'Emerging work', status: 'waiting' })
    expect(stored.document.tasks[0]).toMatchObject({ title: 'Session to-inbox', status: 'waiting', model: 'mock:auto-model' })
    expect(stored.document.runs[0]).toMatchObject({ origin: 'observed', sessionId: 'session:auto-inbox', status: 'waiting' })
    await expect(domain.intakeSession({ sessionId: agent.id, intakeId: FactoryIntakeId('intake:not-blank'), prompt: 'duplicate', destination: 'task' })).rejects.toThrow(/requires a blank idle Session/u)
    list.mockRestore()
  })

  it('creates one draft Emerging task from a blank Session without prompting or binding it', async () => {
    const { context, domain, projectPath } = await fixture()
    const inject = vi.fn()
    const agent = {
      id: 'session:intake-task', status: 'idle', session: { header: { cwd: projectPath, agentPreset: 'fabric' }, events: [] },
      options: { provider: 'mock', model: 'intake-model' }, inject,
    } as unknown as Agent
    const list = vi.spyOn(context.agents, 'list').mockReturnValue([agent])
    context.emit('agent/created', { agent })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await domain.readStore()).document.tasks).toHaveLength(0)

    const result = await domain.intakeSession({
      sessionId: agent.id,
      intakeId: FactoryIntakeId('intake:first-task'),
      prompt: 'Inspect the workspace and repair the failing generated client.',
      destination: 'task',
      attachments: [{ name: 'failure.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }],
    })
    const intaken = result.snapshot
    const task = intaken.document.tasks.find(candidate => candidate.id === result.taskId)
    const flow = intaken.document.flows[0]
    expect(task).toMatchObject({
      flowId: flow?.id, intakeSessionId: agent.id, status: 'draft', lane: { mode: 'isolated' }, preset: 'fabric', model: 'mock:intake-model',
      attachments: [expect.objectContaining({ name: 'failure.png', mediaType: 'image/png' })],
    })
    expect(flow).toMatchObject({ kind: 'inbox', title: 'Emerging work', taskIds: [task?.id], status: 'draft' })
    expect(intaken.document.runs).toHaveLength(0)
    expect(inject).not.toHaveBeenCalled()

    const repeated = await domain.intakeSession({
      sessionId: agent.id, intakeId: FactoryIntakeId('intake:first-task'), prompt: task?.prompt ?? '', destination: 'task',
    })
    expect(repeated.taskId).toBe(result.taskId)
    expect(repeated.snapshot.revision).toBe(result.snapshot.revision)
    expect(repeated.snapshot.document.tasks).toHaveLength(1)
    await expect(domain.intakeSession({
      sessionId: agent.id, intakeId: FactoryIntakeId('intake:first-task'), prompt: 'Conflicting retry.', destination: 'task',
    })).rejects.toThrow(/reused with another prompt/u)

    const next = await domain.intakeSession({
      sessionId: agent.id, intakeId: FactoryIntakeId('intake:second-task'), prompt: 'Queue an independent follow-up.', destination: 'task',
    })
    expect(next.taskId).not.toBe(result.taskId)
    expect(next.snapshot.document.tasks.map(candidate => candidate.prompt)).toEqual([
      'Inspect the workspace and repair the failing generated client.',
      'Queue an independent follow-up.',
    ])
    const cancelled = await domain.cancel({ taskId: result.taskId, expectedRevision: next.snapshot.revision })
    const deleted = await domain.deleteTask({ taskId: result.taskId, expectedRevision: cancelled.revision })
    expect(deleted.document.tasks.map(candidate => candidate.id)).toEqual([next.taskId])
    expect(deleted.document.flows[0]).toMatchObject({ kind: 'inbox', taskIds: [next.taskId], status: 'draft' })
    expect(inject).not.toHaveBeenCalled()
    list.mockRestore()
  })

  it('projects observed Session start and abrupt disappearance onto the task lifecycle', async () => {
    const { context, domain, projectPath } = await fixture()
    let status: 'idle' | 'running' = 'idle'
    let visible = true
    const agent = {
      id: 'session:lifecycle', get status() { return status }, session: { header: { cwd: projectPath }, events: [{ type: 'user/message' }] }, options: {}, inject: vi.fn(),
    } as unknown as Agent
    const list = vi.spyOn(context.agents, 'list').mockImplementation(() => visible ? [agent] : [])
    context.emit('agent/created', { agent })
    const adoptionDeadline = Date.now() + 2_000
    let stored = await domain.readStore()
    while (stored.document.tasks.length === 0) {
      if (Date.now() >= adoptionDeadline) throw new Error('active Session was not adopted')
      await new Promise(resolve => setTimeout(resolve, 10))
      stored = await domain.readStore()
    }

    status = 'running'
    context.emit('agent/status', { agent, status })
    const runningDeadline = Date.now() + 2_000
    while (stored.document.tasks[0]?.status !== 'running') {
      if (Date.now() >= runningDeadline) throw new Error('observed run did not become running')
      await new Promise(resolve => setTimeout(resolve, 10))
      stored = await domain.readStore()
    }
    expect(stored.document.runs[0]?.status).toBe('running')

    visible = false
    context.emit('agent/disposed', { agent })
    const failedDeadline = Date.now() + 2_000
    while (stored.document.tasks[0]?.status !== 'failed') {
      if (Date.now() >= failedDeadline) throw new Error('observed run did not fail after Session disposal')
      await new Promise(resolve => setTimeout(resolve, 10))
      stored = await domain.readStore()
    }
    expect(stored.document.tasks[0]).toMatchObject({ status: 'failed', failure: 'Observed Session ended before factory_finish' })
    expect(stored.document.runs[0]).toMatchObject({ status: 'failed', failure: 'Observed Session ended before factory_finish' })
    expect(stored.document.activities).toContainEqual(expect.objectContaining({ kind: 'run-failed-abruptly' }))
    const runId = stored.document.runs[0]?.id
    if (runId === undefined) throw new Error('observed run is missing')
    const reviewed = await domain.reviewRuns({ runIds: [runId] })
    expect(reviewed.document.runs[0]?.reviewedAt).toEqual(expect.any(String))
    list.mockRestore()
  })

  it('places New Session tasks as sequential, finalizer, or parallel nodes in an existing flow', async () => {
    const { context, domain, projectPath } = await fixture()
    const rootTask = (await domain.createTask({ projectPath, title: 'Root', prompt: 'root' })).document.tasks[0]!
    const leafSnapshot = await domain.createTask({ projectPath, title: 'Leaf', prompt: 'leaf', dependencyIds: [rootTask.id] })
    const leaf = leafSnapshot.document.tasks.find(task => task.title === 'Leaf')!
    const grouped = await domain.groupTasks({ taskIds: [rootTask.id, leaf.id], title: 'Release flow', expectedRevision: leafSnapshot.revision })
    const flow = grouped.document.flows.find(candidate => candidate.kind === 'standard')!
    const agents = ['sequential', 'finalizer', 'parallel'].map(suffix => ({
      id: `session:${suffix}`, status: 'idle', session: { header: { cwd: projectPath }, events: [] }, options: {}, inject: vi.fn(),
    } as unknown as Agent))
    const list = vi.spyOn(context.agents, 'list').mockReturnValue(agents)
    await expect(domain.intakeSession({ sessionId: agents[0]!.id, intakeId: FactoryIntakeId('intake:invalid'), prompt: 'Invalid placement.', destination: 'flow', flowId: flow.id })).rejects.toThrow(/requires a flow and placement/u)

    const sequential = await domain.intakeSession({
      sessionId: agents[0]!.id, intakeId: FactoryIntakeId('intake:sequential'), prompt: 'Verify the release.', destination: 'flow', flowId: flow.id, placement: 'sequential',
    })
    const sequentialTask = sequential.snapshot.document.tasks.find(task => task.id === sequential.taskId)!
    expect(sequentialTask).toMatchObject({ flowId: flow.id, dependencyIds: [leaf.id], finalizer: false })

    const finalized = await domain.intakeSession({
      sessionId: agents[1]!.id, intakeId: FactoryIntakeId('intake:finalizer'), prompt: 'Always clean the checkout.', destination: 'flow', flowId: flow.id, placement: 'finalizer',
    })
    const finalizer = finalized.snapshot.document.tasks.find(task => task.id === finalized.taskId)!
    expect(finalizer).toMatchObject({ flowId: flow.id, dependencyIds: [sequentialTask.id], finalizer: true, finalizerPolicy: 'always' })

    const parallel = await domain.intakeSession({
      sessionId: agents[2]!.id, intakeId: FactoryIntakeId('intake:parallel'), prompt: 'Prepare release notes in parallel.', destination: 'flow', flowId: flow.id, placement: 'parallel',
    })
    const parallelTask = parallel.snapshot.document.tasks.find(task => task.id === parallel.taskId)!
    expect(parallelTask).toMatchObject({ flowId: flow.id, dependencyIds: [], finalizer: false })
    expect(parallel.snapshot.document.flows.find(candidate => candidate.id === flow.id)?.taskIds).toEqual([
      rootTask.id, leaf.id, sequentialTask.id, finalizer.id, parallelTask.id,
    ])
    expect(parallel.snapshot.document.tasks.find(task => task.id === finalizer.id)?.dependencyIds).toEqual([sequentialTask.id, parallelTask.id])
    list.mockRestore()
  })

  it('creates and metadata-labels a new flow from its first New Session task', async () => {
    const { context, domain, projectPath } = await fixture(true)
    const agent = {
      id: 'session:new-flow', status: 'idle', session: { header: { cwd: projectPath }, events: [] }, options: {}, inject: vi.fn(),
    } as unknown as Agent
    const list = vi.spyOn(context.agents, 'list').mockReturnValue([agent])

    const intaken = await domain.intakeSession({
      sessionId: agent.id, intakeId: FactoryIntakeId('intake:new-flow'), prompt: 'Prepare and verify the release flow.', destination: 'new-flow',
    })
    const flowId = intaken.snapshot.document.flows.find(flow => flow.kind === 'standard')?.id
    expect(flowId).toBeDefined()
    const deadline = Date.now() + 2_000
    let settled = await domain.snapshot()
    while (settled.document.metadataGenerations[0]?.status === 'running') {
      if (Date.now() >= deadline) throw new Error('intake metadata generation timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
      settled = await domain.snapshot()
    }
    expect(settled.document.tasks[0]).toMatchObject({ title: 'Generated task title', description: 'Generated task description.' })
    expect(settled.document.flows.find(flow => flow.id === flowId)).toMatchObject({ title: 'Generated task title', description: 'Generated task description.' })
    const repeated = await domain.intakeSession({ sessionId: agent.id, intakeId: FactoryIntakeId('intake:new-flow'), prompt: 'Prepare and verify the release flow.', destination: 'new-flow' })
    expect(repeated.taskId).toBe(intaken.taskId)
    expect(repeated.snapshot.revision).toBe(settled.revision)
    expect(repeated.snapshot.document.tasks.find(task => task.id === repeated.taskId)?.title).toBe('Generated task title')
    expect(repeated.snapshot.document.flows.filter(flow => flow.kind === 'standard')).toHaveLength(1)
    list.mockRestore()
  })

  it('logs custom workspace metadata prompts through the configured title model', async () => {
    const { domain, projectPath } = await fixture(true)
    const configured = await domain.updateProject({
      projectPath,
      settings: {
        model: 'mock:task-model', titleModel: 'mock:title-model', autoTitle: true,
        titlePrompt: 'Use a release-oriented title.', descriptionPrompt: 'Name the verification outcome.', lane: { mode: 'isolated' },
      },
    })
    const created = await domain.createTask({ projectPath, prompt: 'Implement durable workspace title generation and verify it.', expectedRevision: configured.revision })
    expect(created.document.tasks[0]).toMatchObject({ title: 'Generated task title', description: 'Generated task description.', status: 'draft' })
    expect(created.document.metadataGenerations).toEqual([
      expect.objectContaining({
        status: 'succeeded', route: { provider: 'mock', model: 'title-model' }, target: { kind: 'task', id: created.document.tasks[0]?.id },
        system: expect.stringMatching(/release-oriented title[\s\S]*verification outcome/u), output: expect.stringContaining('Generated task title'),
      }),
    ])
  })

  it('keeps deterministic metadata and logs a bounded failure when generation is invalid', async () => {
    const { domain, projectPath } = await fixture(true, 'not-json')
    const created = await domain.createTask({ projectPath, prompt: 'Retain this fallback title. Include the complete prompt as context.' })
    expect(created.document.tasks[0]).toMatchObject({ title: 'Retain this fallback title.', description: 'Retain this fallback title. Include the complete prompt as context.' })
    expect(created.document.metadataGenerations[0]).toMatchObject({ status: 'failed', error: 'Factory metadata model returned invalid JSON' })
    expect(created.document.metadataGenerations[0]?.output).toBeUndefined()
  })

  it('stores complete workspace defaults and applies checkout inheritance without materializing its model on tasks', async () => {
    const { domain, projectPath } = await fixture()
    const configured = await domain.updateProject({
      projectPath,
      settings: {
        model: 'provider:workspace-model', titleModel: 'provider:title-model', autoTitle: false,
        titlePrompt: '', descriptionPrompt: '', lane: { mode: 'current' }, setupCommand: 'pnpm install',
      },
    })
    expect(configured.document.projects[0]?.settings).toEqual({
      model: 'provider:workspace-model', titleModel: 'provider:title-model', autoTitle: false,
      lane: { mode: 'current' }, setupCommand: 'pnpm install',
    })
    const created = await domain.createTask({ projectPath, title: 'Inherited task', description: 'Explicit', prompt: 'work', expectedRevision: configured.revision })
    expect(created.document.tasks[0]).toMatchObject({ lane: { mode: 'current' } })
    expect(created.document.tasks[0]?.model).toBeUndefined()
  })

  it('rejects terminal tasks as newly selected dependencies', async () => {
    const { domain, projectPath } = await fixture()
    const terminalTask = (await domain.createTask({ projectPath, title: 'Terminal', prompt: 'terminal' })).document.tasks[0]!
    const cancelled = await domain.cancel({ taskId: terminalTask.id })
    const target = (await domain.createTask({ projectPath, title: 'Target', prompt: 'target', expectedRevision: cancelled.revision })).document.tasks.find(task => task.title === 'Target')!

    await expect(domain.connect({ taskId: target.id, dependsOnTaskId: terminalTask.id })).rejects.toThrow(/terminal status cancelled/u)
    await expect(domain.updateTask({ taskId: target.id, dependencyIds: [terminalTask.id] })).rejects.toThrow(/terminal status cancelled/u)
  })

  it('permanently deletes a cancelled unlinked task and cleans its durable graph records', async () => {
    const { domain, projectPath } = await fixture()
    const sourceSnapshot = await domain.createTask({ projectPath, title: 'Disposable', prompt: 'discard', enqueue: true })
    const source = sourceSnapshot.document.tasks[0]!
    const targetSnapshot = await domain.createTask({
      projectPath, title: 'Retained', prompt: 'retain', dependencyIds: [source.id], expectedRevision: sourceSnapshot.revision,
    })
    const target = targetSnapshot.document.tasks.find(task => task.title === 'Retained')!
    const grouped = await domain.groupTasks({
      taskIds: [source.id, target.id], title: 'Disposable flow', expectedRevision: targetSnapshot.revision,
    })
    await domain.acquireSchedulerLease(10_000)
    const claim = (await domain.claimReadyTasks(1))[0]
    expect(claim?.task.id).toBe(source.id)
    expect(claim?.run.sessionId).toBeUndefined()
    const claimed = await domain.readStore()
    const cancelled = await domain.cancel({ taskId: source.id, expectedRevision: claimed.revision })

    const deleted = await domain.deleteTask({ taskId: source.id, expectedRevision: cancelled.revision })

    expect(deleted.document.tasks).toEqual([expect.objectContaining({ id: target.id, dependencyIds: [] })])
    expect(deleted.document.runs).toHaveLength(0)
    expect(deleted.document.flows).toEqual([
      expect.objectContaining({ id: grouped.document.flows[0]?.id, taskIds: [target.id], status: 'draft' }),
    ])
    expect(deleted.document.activities.some(entry => entry.taskId === source.id)).toBe(false)
    expect(deleted.document.activities).toContainEqual(expect.objectContaining({ kind: 'task-deleted', message: `${source.identifier} permanently deleted` }))

    const targetCancelled = await domain.cancel({ taskId: target.id, expectedRevision: deleted.revision })
    const emptied = await domain.deleteTask({ taskId: target.id, expectedRevision: targetCancelled.revision })
    expect(emptied.document.tasks).toHaveLength(0)
    expect(emptied.document.flows).toHaveLength(0)
    expect(emptied.document.activities.some(entry => entry.flowId === grouped.document.flows[0]?.id)).toBe(false)
  })

  it('rejects task deletion before cancellation, behind runnable dependents, or after Session binding', async () => {
    const { domain, projectPath } = await fixture()
    let snapshot = await domain.createTask({ projectPath, title: 'Source', prompt: 'source' })
    const source = snapshot.document.tasks[0]!
    await expect(domain.deleteTask({ taskId: source.id })).rejects.toThrow(/only after cancellation/u)

    snapshot = await domain.createTask({
      projectPath, title: 'Runnable dependent', prompt: 'dependent', dependencyIds: [source.id], enqueue: true,
      expectedRevision: snapshot.revision,
    })
    const dependent = snapshot.document.tasks.find(task => task.title === 'Runnable dependent')!
    snapshot = await domain.cancel({ taskId: source.id, expectedRevision: snapshot.revision })
    await expect(domain.deleteTask({ taskId: source.id })).rejects.toThrow(/cannot be deleted while .* is queued/u)
    snapshot = await domain.cancel({ taskId: dependent.id, expectedRevision: snapshot.revision })
    snapshot = await domain.deleteTask({ taskId: dependent.id, expectedRevision: snapshot.revision })
    snapshot = await domain.deleteTask({ taskId: source.id, expectedRevision: snapshot.revision })

    snapshot = await domain.createTask({
      projectPath, title: 'Session-backed', prompt: 'bind a Session', enqueue: true, expectedRevision: snapshot.revision,
    })
    const linked = snapshot.document.tasks[0]!
    await domain.acquireSchedulerLease(10_000)
    const claim = (await domain.claimReadyTasks(1))[0]!
    expect(claim.task.id).toBe(linked.id)
    const bound = await domain.bindRun(claim.run.id, 'session:linked', projectPath)
    const cancelled = await domain.cancel({ taskId: linked.id, expectedRevision: bound.revision })

    await expect(domain.deleteTask({ taskId: linked.id, expectedRevision: cancelled.revision })).rejects.toThrow(/linked Session/u)
  })

  it('groups explicit standalone tasks and starts delayed stages atomically', async () => {
    const { domain, projectPath } = await fixture()
    const implementation = (await domain.createTask({ projectPath, title: 'Implementation', prompt: 'implement' })).document.tasks[0]!
    const reviewSnapshot = await domain.createTask({
      projectPath, title: 'Review', prompt: 'review', dependencyIds: [implementation.id],
      automation: { trigger: { kind: 'delay', delayMinutes: 15 } },
    })
    const review = reviewSnapshot.document.tasks.find(task => task.title === 'Review')!
    const grouped = await domain.groupTasks({ taskIds: [implementation.id, review.id], title: 'Release confidence', expectedRevision: reviewSnapshot.revision })
    const flow = grouped.document.flows[0]!
    expect(flow).toMatchObject({ title: 'Release confidence', status: 'draft', taskIds: [implementation.id, review.id] })
    expect(grouped.document.tasks.find(task => task.id === review.id)?.automation).toMatchObject({ enabled: false, trigger: { kind: 'delay', delayMinutes: 15 } })

    const started = await domain.startFlow({ flowId: flow.id, expectedRevision: grouped.revision })
    expect(started.document.tasks.find(task => task.id === implementation.id)?.status).toBe('queued')
    expect(started.document.tasks.find(task => task.id === review.id)).toMatchObject({ status: 'draft', automation: { enabled: true } })
    await expect(domain.startFlow({ flowId: flow.id })).rejects.toThrow(/cannot start/u)
  })

  it('claims explicit parallel roots, then unlocks their dependent node', async () => {
    const { domain, projectPath } = await fixture()
    const left = (await domain.createTask({ projectPath, title: 'Left', prompt: 'left', enqueue: true })).document.tasks[0]!
    const rightSnapshot = await domain.createTask({ projectPath, title: 'Right', prompt: 'right', enqueue: true })
    const right = rightSnapshot.document.tasks.find(task => task.title === 'Right')!
    const joinSnapshot = await domain.createTask({ projectPath, title: 'Join', prompt: 'join', dependencyIds: [left.id, right.id], enqueue: true })
    const join = joinSnapshot.document.tasks.find(task => task.title === 'Join')!
    await domain.groupTasks({ taskIds: [left.id, right.id, join.id], title: 'Parallel flow', expectedRevision: joinSnapshot.revision })
    expect(await domain.acquireSchedulerLease(10_000)).toBe(true)
    const roots = await domain.claimReadyTasks(3)
    expect(roots.map(claim => claim.task.title).sort()).toEqual(['Left', 'Right'])
    for (const claim of roots) await domain.finishRun(claim.run.id, { outcome: 'succeeded', summary: `${claim.task.title} done`, mutations: [] })
    expect((await domain.claimReadyTasks(3)).map(claim => claim.task.title)).toEqual(['Join'])
  })

  it('lists image and video artifacts from the exact run checkout and reads only the listed revision', async () => {
    const { domain, projectPath } = await fixture()
    const mainArtifacts = join(projectPath, '.artifacts')
    await mkdir(mainArtifacts)
    await writeFile(join(mainArtifacts, 'wrong-checkout.png'), 'main')
    const isolated = join(root!, 'isolated-checkout')
    const artifacts = join(isolated, '.artifacts')
    await mkdir(join(artifacts, 'nested'), { recursive: true })
    await Promise.all([
      writeFile(join(artifacts, 'review.png'), 'png'),
      writeFile(join(artifacts, 'walkthrough.mp4'), 'video'),
      writeFile(join(artifacts, 'nested', 'detail.webp'), 'webp'),
      writeFile(join(artifacts, 'notes.txt'), 'ignore'),
    ])
    const created = await domain.createTask({ projectPath, title: 'Artifact review', prompt: 'Review media', enqueue: true })
    const task = created.document.tasks[0]!
    await domain.acquireSchedulerLease(10_000)
    const claim = (await domain.claimReadyTasks(1))[0]!
    await domain.bindRun(claim.run.id, 'session:artifact-review', isolated)

    const media = await domain.artifactMedia({ taskId: task.id, runId: claim.run.id })
    expect(media.map(item => [item.path, item.kind, item.mediaType])).toEqual([
      ['nested/detail.webp', 'image', 'image/webp'],
      ['review.png', 'image', 'image/png'],
      ['walkthrough.mp4', 'video', 'video/mp4'],
    ])
    expect(media.some(item => item.name === 'wrong-checkout.png')).toBe(false)
    const image = media.find(item => item.name === 'review.png')!
    await expect(domain.artifactMediaData({ taskId: task.id, runId: claim.run.id, media: [{ mediaId: image.id, version: image.version }] })).resolves.toEqual([{
      mediaId: image.id, version: image.version, dataUrl: 'data:image/png;base64,cG5n',
    }])
    await expect(domain.artifactMediaData({ taskId: task.id, runId: claim.run.id, media: [{ mediaId: image.id, version: 'stale' }] })).rejects.toThrow(/changed after listing/u)
    await expect(domain.artifactMediaData({ taskId: task.id, runId: claim.run.id, media: [{ mediaId: FactoryArtifactMediaId('../outside.png'), version: image.version }] })).rejects.toThrow(/does not exist/u)
    await expect(domain.artifactMediaData({ taskId: task.id, runId: claim.run.id, media: [{ mediaId: image.id, version: image.version }, { mediaId: image.id, version: image.version }] })).rejects.toThrow(/duplicate ids/u)
    await expect(domain.artifactMedia({ taskId: task.id, runId: 'run:missing' as never })).rejects.toThrow(/does not exist/u)
  })

  it('queues one-shot scheduled and dependency-delayed prompts only when due', async () => {
    const { domain, projectPath } = await fixture()
    const rootSnapshot = await domain.createTask({ projectPath, title: 'Root', prompt: 'root', enqueue: true })
    const rootTask = rootSnapshot.document.tasks[0]!
    const delayedSnapshot = await domain.createTask({
      projectPath, title: 'Delayed review', prompt: 'review', dependencyIds: [rootTask.id], enqueue: true,
      automation: { trigger: { kind: 'delay', delayMinutes: 5 } },
    })
    const delayed = delayedSnapshot.document.tasks.find(task => task.title === 'Delayed review')!
    expect(delayed).toMatchObject({ status: 'draft', automation: { enabled: true, trigger: { kind: 'delay', delayMinutes: 5 } } })
    expect(await domain.activateDueAutomations('2099-01-01T00:00:00.000Z')).toBe(0)

    await domain.acquireSchedulerLease(10_000)
    const rootClaim = (await domain.claimReadyTasks(1))[0]!
    await domain.finishRun(rootClaim.run.id, { outcome: 'succeeded', summary: 'root complete', mutations: [] })
    const completedRoot = (await domain.readStore()).document.tasks.find(task => task.id === rootTask.id)!
    const beforeDue = new Date(Date.parse(completedRoot.updatedAt) + 4 * 60_000).toISOString()
    const atDue = new Date(Date.parse(completedRoot.updatedAt) + 5 * 60_000).toISOString()
    expect(await domain.activateDueAutomations(beforeDue)).toBe(0)
    expect((await domain.readStore()).document.tasks.find(task => task.id === delayed.id)?.automation?.nextRunAt).toBe(atDue)
    expect(await domain.activateDueAutomations(atDue)).toBe(1)
    expect((await domain.readStore()).document.tasks.find(task => task.id === delayed.id)).toMatchObject({ status: 'queued', automation: { enabled: false } })

    const scheduledAt = '2099-02-01T12:00:00.000Z'
    const scheduled = await domain.createTask({ projectPath, title: 'One time', prompt: 'scheduled', enqueue: true, automation: { trigger: { kind: 'schedule', at: scheduledAt } } })
    const scheduledTask = scheduled.document.tasks.find(task => task.title === 'One time')!
    expect(scheduledTask.status).toBe('draft')
    expect(await domain.activateDueAutomations('2099-02-01T11:59:59.999Z')).toBe(0)
    expect(await domain.activateDueAutomations(scheduledAt)).toBe(1)

    const manual = await domain.createTask({ projectPath, title: 'Manual gate', prompt: 'manual', enqueue: true, automation: { trigger: { kind: 'manual' } } })
    const manualTask = manual.document.tasks.find(task => task.title === 'Manual gate')!
    expect(manualTask).toMatchObject({ status: 'draft', automation: { enabled: true, trigger: { kind: 'manual' } } })
    const released = await domain.enqueue({ taskId: manualTask.id })
    expect(released.document.tasks.find(task => task.id === manualTask.id)).toMatchObject({ status: 'queued', automation: { enabled: false } })
  })

  it('runs recurring tasks repeatedly, retains Triage results, and never completes the schedule', async () => {
    const { domain, projectPath } = await fixture()
    const created = await domain.createTask({
      projectPath, title: 'Recurring review', prompt: 'Review changes',
      automation: { trigger: { kind: 'recurring', schedule: { kind: 'cron', expression: '* * * * *' } }, enabled: true },
    })
    const task = created.document.tasks[0]!
    const firstAt = task.automation?.nextRunAt
    if (firstAt === undefined) throw new Error('recurring task has no next run')
    expect(task.status).toBe('scheduled')
    expect(await domain.activateDueAutomations(new Date(Date.parse(firstAt) - 1).toISOString())).toBe(0)
    expect(await domain.activateDueAutomations(firstAt)).toBe(1)
    await domain.acquireSchedulerLease(10_000)
    const claim = (await domain.claimReadyTasks(1))[0]!
    await domain.finishRun(claim.run.id, { outcome: 'succeeded', summary: 'Recurring review complete', artifacts: ['report.md'], mutations: [] })
    const settled = await domain.readStore()
    const settledTask = settled.document.tasks[0]!
    const firstRun = settled.document.runs[0]!
    expect(settledTask).toMatchObject({ status: 'scheduled', output: { summary: 'Recurring review complete' }, automation: { enabled: true } })
    expect(firstRun).toMatchObject({ status: 'succeeded', schedule: { kind: 'cron', expression: '* * * * *' }, output: { summary: 'Recurring review complete' } })
    expect(firstRun.reviewedAt).toBeUndefined()
    const reviewed = await domain.reviewRuns({ runIds: [firstRun.id] })
    expect(reviewed.document.runs[0]?.reviewedAt).toEqual(expect.any(String))

    const secondAt = settledTask.automation?.nextRunAt
    if (secondAt === undefined) throw new Error('recurring task did not advance')
    expect(Date.parse(secondAt)).toBeGreaterThan(Date.parse(firstAt))
    expect(await domain.activateDueAutomations(secondAt)).toBe(1)
    const second = (await domain.claimReadyTasks(1))[0]!
    await domain.requeueOrphanedRuns(new Set(), new Set(), 1)
    expect((await domain.readStore()).document.tasks[0]).toMatchObject({ status: 'scheduled', automation: { enabled: true } })
    expect(second.run.id).not.toBe(firstRun.id)
  })

  it('serializes current-checkout tasks even when global capacity remains', async () => {
    const { domain, projectPath } = await fixture()
    await domain.createTask({ projectPath, title: 'One', prompt: 'one', lane: { mode: 'current' }, enqueue: true })
    await domain.createTask({ projectPath, title: 'Two', prompt: 'two', lane: { mode: 'current' }, enqueue: true })
    await domain.acquireSchedulerLease(10_000)
    const first = await domain.claimReadyTasks(3)
    expect(first).toHaveLength(1)
    await domain.finishRun(first[0]!.run.id, { outcome: 'succeeded', summary: 'done', mutations: [] })
    expect(await domain.claimReadyTasks(3)).toHaveLength(1)
  })

  it('runs explicit always-finalizers after failed ordinary nodes settle', async () => {
    const { domain, projectPath } = await fixture()
    const work = (await domain.createTask({ projectPath, title: 'Work', prompt: 'work', enqueue: true })).document.tasks[0]!
    const cleanupSnapshot = await domain.createTask({
      projectPath, title: 'Cleanup', prompt: 'cleanup', dependencyIds: [work.id], enqueue: true,
      finalizer: true, finalizerPolicy: 'always',
    })
    const cleanup = cleanupSnapshot.document.tasks.find(task => task.title === 'Cleanup')!
    await domain.groupTasks({ taskIds: [work.id, cleanup.id], title: 'Cleanup flow', expectedRevision: cleanupSnapshot.revision })
    await domain.acquireSchedulerLease(10_000)
    const claim = (await domain.claimReadyTasks(2))[0]!
    await domain.finishRun(claim.run.id, { outcome: 'failed', summary: 'expected failure', mutations: [] })
    expect((await domain.claimReadyTasks(2))[0]?.task.id).toBe(cleanup.id)
  })

  it('attaches an observed emerging Session without inventing an Agent runtime', async () => {
    const { domain, projectPath, store } = await fixture()
    await domain.createTask({ projectPath, title: 'Adopt', prompt: 'continue' })
    const snapshot = await domain.createTask({ projectPath, title: 'Other', prompt: 'other' })
    const task = snapshot.document.tasks[0]!
    const other = snapshot.document.tasks[1]!
    const processId = FactoryProcessId('process:other')
    await store.replaceAgentObservations(processId, [{ processId, agentId: 'session:outside', sessionId: 'session:outside', status: 'idle', cwd: projectPath, heartbeatAt: new Date().toISOString() }])
    const attached = await domain.attachSession({ taskId: task.id, sessionId: 'session:outside' })
    expect(attached.document.tasks[0]).toMatchObject({ status: 'waiting', activeRunId: expect.any(String) })
    expect(attached.document.runs[0]).toMatchObject({ origin: 'observed', processId, sessionId: 'session:outside', status: 'waiting' })
    await expect(domain.attachSession({ taskId: other.id, sessionId: 'session:outside' })).rejects.toThrow(/already assigned/)
    await expect(domain.updateTask({ taskId: task.id, title: 'Unsafe edit' })).rejects.toThrow(/run is active/)
    await expect(domain.connect({ taskId: task.id, dependsOnTaskId: other.id })).rejects.toThrow(/run is active/)
  })

  it('sinks live Sessions as normal tasks, edits their graph, and creates a connected flow', async () => {
    const { domain, projectPath, store } = await fixture()
    const processId = FactoryProcessId('process:adoption')
    const heartbeatAt = new Date().toISOString()
    await store.replaceAgentObservations(processId, [
      { processId, agentId: 'session:left', sessionId: 'session:left', status: 'idle', cwd: projectPath, provider: 'mock', model: 'left-model', title: 'Investigate parser', heartbeatAt },
      { processId, agentId: 'session:right', sessionId: 'session:right', status: 'running', cwd: projectPath, provider: 'mock', model: 'right-model', title: 'Verify browser', heartbeatAt },
    ])
    const adopted = await domain.adoptSessions({ sessionIds: ['session:left', 'session:right'] })
    const inbox = adopted.document.flows[0]
    const [left, right] = adopted.document.tasks
    if (inbox === undefined || left === undefined || right === undefined) throw new Error('inbox tasks not created')
    expect(inbox).toMatchObject({ kind: 'inbox', title: 'Emerging work', status: 'waiting', taskIds: [left.id, right.id] })
    expect(adopted.agents.map(agent => agent.taskId)).toEqual([left.id, right.id])
    expect(adopted.document.runs.every(run => run.origin === 'observed')).toBe(true)
    await domain.acquireSchedulerLease(10_000)
    const unrecovered = await domain.requeueOrphanedRuns(new Set(), new Set(), 1)
    expect(unrecovered.revision).toBe(adopted.revision)

    const connected = await domain.connect({ taskId: right.id, dependsOnTaskId: left.id, expectedRevision: adopted.revision })
    const replaced = await domain.updateTask({ taskId: right.id, dependencyIds: [left.id], expectedRevision: connected.revision })
    await expect(domain.updateTask({ taskId: right.id, title: 'Unsafe while live', expectedRevision: replaced.revision })).rejects.toThrow(/run is active/u)
    await expect(domain.groupTasks({ taskIds: [right.id], title: 'Incomplete', expectedRevision: replaced.revision })).rejects.toThrow(/every connected inbox task/u)
    const grouped = await domain.groupTasks({ taskIds: [left.id, right.id], title: 'Parser confidence', expectedRevision: replaced.revision })
    expect(grouped.document.flows).toEqual([
      expect.objectContaining({ kind: 'inbox', title: 'Emerging work', taskIds: [], status: 'draft' }),
      expect.objectContaining({ kind: 'standard', title: 'Parser confidence', taskIds: [left.id, right.id], status: 'waiting' }),
    ])
    const repeated = await domain.adoptSessions({ sessionIds: ['session:left', 'session:right'] })
    expect(repeated.revision).toBe(grouped.revision)
  })

  it('requeues one orphaned attempt and fails at the configured retry ceiling', async () => {
    const { domain, projectPath } = await fixture()
    await domain.createTask({ projectPath, title: 'Recover', prompt: 'recover', enqueue: true })
    await domain.acquireSchedulerLease(10_000)
    const first = (await domain.claimReadyTasks(1))[0]!
    expect(first.run.origin).toBe('scheduler')
    await domain.requeueOrphanedRuns(new Set(), new Set(), 2)
    expect((await domain.readStore()).document.tasks[0]?.status).toBe('queued')
    const second = (await domain.claimReadyTasks(1))[0]!
    expect(second.run.attempt).toBe(2)
    await domain.requeueOrphanedRuns(new Set(), new Set(), 2)
    expect((await domain.readStore()).document.tasks[0]).toMatchObject({ status: 'failed', failure: expect.stringContaining('disappeared') })
    expect(first.run.id).not.toBe(second.run.id)
  })
})
