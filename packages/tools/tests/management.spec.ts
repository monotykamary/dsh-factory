import { Context, Service } from '@monotykamary/cordis'
import { CallId } from '@monotykamary/dsh-llm'
import SkillRegistry from '@monotykamary/dsh-skill'
import SystemPrompt from '@monotykamary/dsh-system-prompt'
import ToolRuntime from '@monotykamary/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FactoryFlowId, FactoryProcessId, FactoryProjectId, FactoryTaskId, emptyFactoryDocument,
  type FactoryAdoptSessionsRequest, type FactoryAttachSessionRequest, type FactoryCommentRequest, type FactoryCreateTaskRequest,
  type FactoryFlowActionRequest, type FactoryGroupTasksRequest, type FactorySnapshot, type FactoryTask,
  type FactoryTaskActionRequest, type FactoryUpdateProjectRequest, type FactoryUpdateTaskRequest,
} from 'dsh-factory-protocol'
import * as FactoryTools from '../src/index.ts'

const now = '2026-08-23T00:00:00.000Z'
const projectId = FactoryProjectId('project:test')
const taskId = FactoryTaskId('task:test')
let ctx: Context | undefined
let callNumber = 0

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

function task(id: ReturnType<typeof FactoryTaskId>, title: string): FactoryTask {
  return {
    id, identifier: 'FAC-1', projectId, title, description: 'Existing description', prompt: 'Existing prompt',
    status: 'draft', priority: 3, labels: ['existing'], dependencyIds: [], lane: { mode: 'isolated' },
    finalizer: false, attachments: [], comments: [], createdAt: now, updatedAt: now,
  }
}

class FakeFactory extends Service {
  readonly document = emptyFactoryDocument()
  revision = 7
  readonly createTask = vi.fn((request: FactoryCreateTaskRequest): Promise<FactorySnapshot> => {
    const value = task(FactoryTaskId(`task:created-${String(this.document.tasks.length)}`), request.title ?? 'Generated task')
    value.prompt = request.prompt
    value.status = request.automation?.trigger.kind === 'recurring' ? 'scheduled' : request.enqueue === true && request.automation === undefined ? 'queued' : 'draft'
    if (request.automation !== undefined) value.automation = { ...request.automation, enabled: request.automation.enabled ?? request.enqueue ?? false }
    value.finalizer = request.finalizer ?? false
    if (request.finalizerPolicy !== undefined) value.finalizerPolicy = request.finalizerPolicy
    this.document.tasks.push(value)
    return Promise.resolve(this.value())
  })
  readonly start = vi.fn((request: FactoryFlowActionRequest): Promise<FactorySnapshot> => {
    const flow = this.document.flows.find(candidate => candidate.id === request.flowId)
    if (flow !== undefined) flow.status = 'queued'
    return Promise.resolve(this.value())
  })
  readonly group = vi.fn((request: FactoryGroupTasksRequest): Promise<FactorySnapshot> => {
    this.document.flows.push({
      id: FactoryFlowId(`flow:${String(this.document.flows.length)}`), projectId, kind: 'standard', title: request.title,
      description: 'Explicit task graph.', taskIds: request.taskIds, status: 'draft', createdAt: now, updatedAt: now,
    })
    return Promise.resolve(this.value())
  })
  readonly update = vi.fn((request: FactoryUpdateTaskRequest): Promise<FactorySnapshot> => {
    const value = this.document.tasks.find(candidate => candidate.id === request.taskId)
    if (value !== undefined && request.title !== undefined) value.title = request.title
    return Promise.resolve(this.value())
  })
  readonly attach = vi.fn((request: FactoryAttachSessionRequest): Promise<FactorySnapshot> => {
    const value = this.document.tasks.find(candidate => candidate.id === request.taskId)
    if (value !== undefined) value.status = 'waiting'
    return Promise.resolve(this.value())
  })
  readonly updateProjectSettings = vi.fn((_request: FactoryUpdateProjectRequest): Promise<FactorySnapshot> => Promise.resolve(this.value()))
  readonly adopt = vi.fn((_request: FactoryAdoptSessionsRequest): Promise<FactorySnapshot> => Promise.resolve(this.value()))
  readonly addComment = vi.fn((_request: FactoryCommentRequest): Promise<FactorySnapshot> => Promise.resolve(this.value()))
  readonly action = vi.fn((_action: string, _request: FactoryTaskActionRequest): Promise<FactorySnapshot> => Promise.resolve(this.value()))

  constructor(context: Context) {
    super(context, 'factory')
    this.document.projects.push({
      id: projectId, title: 'Workspace', mainPath: '/workspace',
      settings: { model: 'mock:task-model', titleModel: 'mock:title-model', autoTitle: true, lane: { mode: 'isolated' } },
      createdAt: now, updatedAt: now,
    })
    this.document.tasks.push(task(taskId, 'Existing task'))
  }

  snapshot(): Promise<FactorySnapshot> { return Promise.resolve(this.value()) }
  startFlow(request: FactoryFlowActionRequest): Promise<FactorySnapshot> { return this.start(request) }
  updateProject(request: FactoryUpdateProjectRequest): Promise<FactorySnapshot> { return this.updateProjectSettings(request) }
  adoptSessions(request: FactoryAdoptSessionsRequest): Promise<FactorySnapshot> { return this.adopt(request) }
  groupTasks(request: FactoryGroupTasksRequest): Promise<FactorySnapshot> { return this.group(request) }
  updateTask(request: FactoryUpdateTaskRequest): Promise<FactorySnapshot> { return this.update(request) }
  attachSession(request: FactoryAttachSessionRequest): Promise<FactorySnapshot> { return this.attach(request) }
  comment(request: FactoryCommentRequest): Promise<FactorySnapshot> { return this.addComment(request) }
  enqueue(request: FactoryTaskActionRequest): Promise<FactorySnapshot> { return this.action('enqueue', request) }
  pause(request: FactoryTaskActionRequest): Promise<FactorySnapshot> { return this.action('pause', request) }
  cancel(request: FactoryTaskActionRequest): Promise<FactorySnapshot> { return this.action('cancel', request) }
  retry(request: FactoryTaskActionRequest): Promise<FactorySnapshot> { return this.action('retry', request) }

  private value(): FactorySnapshot {
    return {
      revision: this.revision, document: this.document, generatedAt: now, defaultModel: 'mock:task-model',
      agents: [{ processId: FactoryProcessId('process:test'), agentId: 'session:user', sessionId: 'session:user', status: 'idle', cwd: '/workspace', heartbeatAt: now }],
    }
  }
}

async function setup(): Promise<{ context: Context; factory: FakeFactory }> {
  ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
  new ToolRuntime(ctx, { mode: 'native' })
  new SkillRegistry(ctx, {})
  const factory = new FakeFactory(ctx)
  await ctx.plugin(FactoryTools)
  return { context: ctx, factory }
}

async function call(context: Context, name: string, arguments_: Record<string, unknown>, agent = true) {
  return context.tools.execute({
    callId: CallId(`factory-${String(++callNumber)}`), name, arguments: arguments_, signal: new AbortController().signal,
    ...(agent ? { agent: { session: { header: { cwd: '/workspace' } } } as never } : {}),
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('Factory management tools', () => {
  it('lists complete task, flow, run, and live Session management identities without patterns', async () => {
    const { context } = await setup()
    const result = await call(context, 'factory_list', {}, false)
    const projection = JSON.parse(text(result)) as {
      revision: number
      defaultModel: string
      tasks: Array<{ id: string; prompt: string }>
      flows: unknown[]
      runs: unknown[]
      agents: Array<{ sessionId: string }>
      patterns?: unknown
    }
    expect(projection).toMatchObject({ revision: 7, defaultModel: 'mock:task-model', flows: [], runs: [] })
    expect(projection.tasks).toContainEqual(expect.objectContaining({ id: taskId, prompt: 'Existing prompt' }))
    expect(projection.agents).toContainEqual(expect.objectContaining({ sessionId: 'session:user' }))
    expect(projection.patterns).toBeUndefined()
  })

  it('creates standalone, recurring, finalizer tasks and an explicit grouped flow', async () => {
    const { context, factory } = await setup()
    const createdTask = await call(context, 'factory_create_task', {
      title: 'Follow up', prompt: 'Implement the follow-up', dependency_ids: [taskId], expected_revision: 7,
    })
    expect(createdTask).toMatchObject({ isError: false })
    expect(factory.createTask).toHaveBeenLastCalledWith(expect.objectContaining({
      projectPath: '/workspace', title: 'Follow up', prompt: 'Implement the follow-up', dependencyIds: [taskId], enqueue: false, expectedRevision: 7,
    }))

    const recurring = await call(context, 'factory_create_task', {
      title: 'Scheduled review', prompt: 'Review every weekday', automation: 'recurring', cron_expression: '0 9 * * 1-5',
      finalizer: true, finalizer_policy: 'always',
    })
    expect(recurring).toMatchObject({ isError: false })
    expect(factory.createTask).toHaveBeenLastCalledWith(expect.objectContaining({
      automation: { enabled: true, trigger: { kind: 'recurring', schedule: { kind: 'cron', expression: '0 9 * * 1-5' } } },
      finalizer: true, finalizerPolicy: 'always',
    }))

    const createdFlow = await call(context, 'factory_create_flow', {
      task_ids: [taskId], title: 'Grouped release', expected_revision: 7,
    })
    expect(createdFlow).toMatchObject({ isError: false })
    expect(factory.group).toHaveBeenCalledWith({ taskIds: [taskId], title: 'Grouped release', expectedRevision: 7 })
    const flowId = factory.document.flows.at(-1)?.id
    if (flowId === undefined) throw new Error('flow not created')
    expect(await call(context, 'factory_start_flow', { flow_id: flowId, expected_revision: 7 })).toMatchObject({ isError: false })
    expect(factory.start).toHaveBeenCalledWith({ flowId, expectedRevision: 7 })
  })

  it('updates complete workspace settings and adopts groups of live Sessions', async () => {
    const { context, factory } = await setup()
    const settings = await call(context, 'factory_update_project', {
      model: 'mock:workspace', title_model: 'mock:title', auto_title: true,
      title_prompt: 'Name the outcome.', description_prompt: 'Describe verification.',
      lane: 'isolated', base_ref: 'origin/main', setup_command: 'pnpm install', expected_revision: 7,
    })
    expect(settings).toMatchObject({ isError: false })
    expect(factory.updateProjectSettings).toHaveBeenCalledWith({
      projectPath: '/workspace',
      settings: {
        model: 'mock:workspace', titleModel: 'mock:title', autoTitle: true,
        titlePrompt: 'Name the outcome.', descriptionPrompt: 'Describe verification.',
        lane: { mode: 'isolated', baseRef: 'origin/main' }, setupCommand: 'pnpm install',
      },
      expectedRevision: 7,
    })

    expect(await call(context, 'factory_adopt_sessions', {
      session_ids: ['session:left', 'session:right'], flow_title: 'Parallel investigation', expected_revision: 7,
    })).toMatchObject({ isError: false })
    expect(factory.adopt).toHaveBeenCalledWith({ sessionIds: ['session:left', 'session:right'], flowTitle: 'Parallel investigation', expectedRevision: 7 })
  })

  it('edits recurring task graphs, attaches Sessions, and preserves lifecycle actions', async () => {
    const { context, factory } = await setup()
    const updated = await call(context, 'factory_update_task', {
      task_id: taskId, title: 'Reframed task', dependency_ids: ['task:predecessor'],
      lane: 'reuse', reuse_task_id: 'task:predecessor', automation: 'recurring', cron_expression: '15 */2 * * *', expected_revision: 7,
    })
    expect(updated).toMatchObject({ isError: false })
    expect(factory.update).toHaveBeenCalledWith({
      taskId, title: 'Reframed task', dependencyIds: [FactoryTaskId('task:predecessor')],
      lane: { mode: 'reuse', reuseTaskId: FactoryTaskId('task:predecessor') },
      automation: { enabled: true, trigger: { kind: 'recurring', schedule: { kind: 'cron', expression: '15 */2 * * *' } } }, expectedRevision: 7,
    })

    expect(await call(context, 'factory_attach_session', { task_id: taskId, session_id: 'session:user', expected_revision: 7 })).toMatchObject({ isError: false })
    expect(factory.attach).toHaveBeenCalledWith({ taskId, sessionId: 'session:user', expectedRevision: 7 })
    await call(context, 'factory_comment', { task_id: taskId, body: 'User context', expected_revision: 7 })
    await call(context, 'factory_task', { task_id: taskId, action: 'cancel', expected_revision: 7 })
    expect(factory.addComment).toHaveBeenCalledWith({ taskId, body: 'User context', expectedRevision: 7 })
    expect(factory.action).toHaveBeenCalledWith('cancel', { taskId, expectedRevision: 7 })
    expect((await context.skills.list()).some(value => value.name === 'factory')).toBe(true)
    const names = context.tools.schemas().map(schema => schema.name)
    expect(names).toContain('factory_create_flow')
    expect(names).not.toContain('factory_save_pattern')
  })

  it('rejects incomplete one-time or recurring automation and empty task updates before mutation', async () => {
    const { context, factory } = await setup()
    const schedule = await call(context, 'factory_create_task', { title: 'Invalid', prompt: 'Invalid', automation: 'schedule' })
    const recurring = await call(context, 'factory_create_task', { title: 'Invalid cron', prompt: 'Invalid', automation: 'recurring' })
    const update = await call(context, 'factory_update_task', { task_id: taskId })
    const reuse = await call(context, 'factory_update_task', { task_id: taskId, lane: 'reuse' })
    expect([schedule, recurring, update, reuse]).toEqual([expect.objectContaining({ isError: true }), expect.objectContaining({ isError: true }), expect.objectContaining({ isError: true }), expect.objectContaining({ isError: true })])
    expect(factory.createTask).not.toHaveBeenCalled()
    expect(factory.update).not.toHaveBeenCalled()
  })
})
