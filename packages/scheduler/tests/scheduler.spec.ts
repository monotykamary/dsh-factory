import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentLoop from '@monotykamary/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@monotykamary/dsh-agent-loop-testkit'
import AttachmentStore, { type ImageAttachmentLimits, type ImageAttachmentRef, type SaveImageAttachment, type StoredImageAttachment } from '@monotykamary/dsh-attachment'
import { Context, Service } from '@monotykamary/cordis'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@monotykamary/dsh-llm'
import ShellExecutor, { type ShellExecRequest, type ShellExecSpec, type ShellProcess, type ShellRunResult } from '@monotykamary/dsh-shell'
import WorktreeRegistry, { type WorktreeProvider } from '@monotykamary/dsh-worktree'
import { SessionId, type SessionEvent } from '@monotykamary/dsh-session'
import UserQuestionService, { type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@monotykamary/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import {
  emptyFactoryDocument, FactoryFlowId, FactoryProjectId, FactoryTaskId, type FactoryTask,
} from 'dsh-factory-protocol'
import { FactoryDomain } from 'dsh-factory-domain'
import * as FactoryTools from 'dsh-factory-tools'
import { SqliteFactoryStore } from 'dsh-factory-store-sqlite'
import * as SchedulerPlugin from '../src/index.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function toolCalls(calls: Array<{ name: string; value: object; callId: string }>): StreamChunk[] {
  const chunks = calls.flatMap(({ name, value, callId }, index): StreamChunk[] => {
    const id = CallId(callId)
    const args = JSON.stringify(value)
    return [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } },
    ]
  })
  return [
    ...chunks,
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function toolCall(name: string, value: object, callId: string): StreamChunk[] {
  return toolCalls([{ name, value, callId }])
}

function finishCall(summary = 'Implemented and verified', callId = 'factory-finish-call'): StreamChunk[] {
  return toolCall('factory_finish', { outcome: 'succeeded', summary, artifacts: ['result.txt'] }, callId)
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][] = [finishCall(), textResponse('Done.')]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('adapter script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

class TestDefaultModel extends Service {
  constructor(context: Context) { super(context, 'agentDefaultModel') }
  currentSelection(): { provider: string; model: string } { return { provider: 'mock', model: 'mock-model' } }
}

class TestPresets extends Service {
  readonly defaultId = 'factory-test'
  constructor(context: Context) { super(context, 'agentPresets') }
  mount(): Promise<{ id: string }> { return Promise.resolve({ id: this.defaultId }) }
}

class TestAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = { maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096, maxImagePixels: 10000, maxImageDimension: 100, mediaTypes: ['image/png'] }
  validateImage(): Promise<void> { return Promise.resolve() }
  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> { return Promise.reject(new Error('no images expected')) }
  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> { return Promise.reject(new Error('no images expected')) }
}

class TestShell extends ShellExecutor {
  readonly specs: ShellExecSpec[] = []
  resolve(request: ShellExecRequest): ShellExecSpec {
    return { command: request.command, workdir: request.workdir ?? '/', timeoutMs: request.timeoutMs ?? 1000, stdoutMaxBytes: 1024, sandboxPolicy: undefined }
  }
  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.specs.push(spec)
    return Promise.resolve({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } })
  }
  start(): ShellProcess { throw new Error('not used') }
}

async function waitFor(check: () => Promise<boolean>, timeout = 4_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for Factory scheduler')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const receiptEvent = (commitOrder: number, path: string): SessionEvent => ({
  type: 'tool/result', seq: commitOrder, time: commitOrder + 1,
  data: { mutations: [{
    version: 1, commitOrder,
    beforeSha1: null, afterSha1: 'a'.repeat(40), beforeSha256: null, afterSha256: 'b'.repeat(64),
    path, operation: 'create', diffs: [{ oldText: null, newText: `created ${path}` }],
  }] },
} as unknown as SessionEvent)

function graphTask(id: string, overrides: Partial<FactoryTask> = {}): FactoryTask {
  return {
    id: FactoryTaskId(id), identifier: id.toUpperCase(), projectId: FactoryProjectId('project'), flowId: FactoryFlowId('flow'),
    title: id, description: '', prompt: id, status: 'queued', priority: 3, labels: [], dependencyIds: [],
    lane: { mode: 'isolated' }, finalizer: false, attachments: [], comments: [],
    createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z', ...overrides,
  }
}

async function schedulerHarness(projectPath: string, adapter: ScriptedAdapter, maxConcurrent = 1) {
  if (root === undefined) throw new Error('scheduler fixture root is unavailable')
  const context = new Context()
  ctx = context
  await mountAgentLoopTestDependencies(context, {
    systemPrompt: { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' },
  })
  context.llm.registerAdapter(['mock'], adapter)
  await context.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  await context.plugin(UserQuestionService)
  new TestDefaultModel(context)
  new TestPresets(context)
  new TestAttachments(context)
  context.provide('sessionTitle', { get: () => undefined } as never)
  const shell = new TestShell(context)
  const worktrees = new WorktreeRegistry(context, { provider: 'fixture' })
  const provider: WorktreeProvider = {
    name: 'fixture',
    locate: request => Promise.resolve({ id: 'repo' as never, provider: request.provider, name: 'Fixture', mainPath: projectPath }),
    list: () => Promise.resolve([{
      id: 'main' as never, repositoryId: 'repo' as never, path: projectPath, branch: 'main', head: 'abc',
      kind: 'main', managed: false, current: true, locked: false, prunable: false, activeSessionIds: [],
    }]),
    create: () => Promise.reject(new Error('current lane must not create a worktree')),
    remove: () => Promise.reject(new Error('current lane must not remove a worktree')),
    sweep: () => Promise.resolve({ removed: [] }),
  }
  worktrees.registerProvider(provider)
  await context.plugin(SqliteFactoryStore, { path: join(root, 'factory.sqlite') })
  await context.plugin(FactoryDomain, { heartbeatMs: 250, presenceTtlMs: 1_000 })
  if (context.get('skills') === undefined) {
    context.provide('skills', { register: () => () => {} } as never)
  }
  FactoryTools.apply(context)
  await context.plugin(SchedulerPlugin, {
    maxConcurrent, maxAttempts: 2, tickMs: 100, leaseTtlMs: 1_000, setupTimeoutMs: 1_000,
    cleanupPolicy: 'retain', sweepOlderThanMs: 60_000, sweepLimit: 1,
  })
  return { context, domain: context.factory, shell }
}

describe('Factory scheduler mutation handoff', () => {
  it('normalizes Session receipts in commit order and carries them into a bounded dependency handoff', () => {
    const mutations = SchedulerPlugin.factoryFileMutations([receiptEvent(2, 'src/b.ts'), receiptEvent(1, 'src/a.ts')])
    expect(mutations.map(mutation => mutation.path)).toEqual(['src/a.ts', 'src/b.ts'])
    const source = graphTask('source', {
      status: 'succeeded',
      output: { summary: 'Implemented source', artifacts: ['report.json'], mutations, completedAt: '2026-08-23T01:00:00.000Z' },
    })
    const target = graphTask('target', { dependencyIds: [source.id] })
    const document = { ...emptyFactoryDocument(), tasks: [source, target] }
    const handoff = SchedulerPlugin.dependencyHandoff(document, target, { maxMutations: 1, maxChars: 10_000 })
    expect(handoff).toContain('Summary: Implemented source')
    expect(handoff).toContain('Artifacts: report.json')
    expect(handoff).toContain('Change #1: create src/a.ts')
    expect(handoff).not.toContain('Change #2:')
    expect(handoff).toContain('1 additional mutation receipts omitted')
    const bounded = SchedulerPlugin.dependencyHandoff(document, target, { maxMutations: 2, maxChars: 80 })
    expect(bounded).toContain('Dependency handoff truncated at 80 characters')
    expect(bounded).toHaveLength(80)
  })
})

describe('FactoryScheduler', () => {
  it('runs a recurring task through a real DSH Agent and returns it to Scheduled with a Triage result', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-factory-scheduler-'))
    const projectPath = join(root, 'repo')
    await mkdir(projectPath)
    const adapter = new ScriptedAdapter()
    const harness = await schedulerHarness(projectPath, adapter)
    const { context, domain, shell } = harness
    let capturedSession: { events: readonly { type: string; data: unknown }[] } | undefined
    context.on('agent/created', ({ agent }) => { capturedSession = agent.session })

    await domain.updateProject({
      projectPath, settings: { model: 'mock:workspace-model', titleModel: 'mock:title-model', autoTitle: false, lane: { mode: 'current' }, setupCommand: 'bun install' },
    })
    const created = await domain.createTask({ projectPath, title: 'Run through DSH', prompt: 'Make the change and verify it.', automation: { trigger: { kind: 'recurring', schedule: { kind: 'cron', expression: '* * * * *' } }, enabled: true } })
    const nextRunAt = created.document.tasks[0]?.automation?.nextRunAt
    if (nextRunAt === undefined) throw new Error('recurring scheduler fixture has no next run')
    await domain.activateDueAutomations(nextRunAt)
    await waitFor(async () => (await domain.readStore()).document.runs[0]?.status === 'succeeded')

    const stored = await domain.readStore()
    expect(stored.document.tasks[0]).toMatchObject({ status: 'scheduled', lane: { mode: 'current' }, automation: { enabled: true, nextRunAt: expect.any(String) }, output: { summary: 'Implemented and verified', artifacts: ['result.txt'], mutations: [] } })
    expect(stored.document.runs[0]).toMatchObject({ origin: 'scheduler', status: 'succeeded', sessionId: expect.stringMatching(/^factory-/), schedule: { kind: 'cron', expression: '* * * * *' }, output: { summary: 'Implemented and verified' } })
    expect(stored.document.runs[0]?.reviewedAt).toBeUndefined()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests.every(request => request.provider === 'mock' && request.model === 'workspace-model')).toBe(true)
    expect(shell.specs).toEqual([expect.objectContaining({ command: 'bun install', workdir: projectPath })])
    const assignment = capturedSession?.events.find(event => event.type === 'user/message' && (event.data as { source?: { kind?: string } }).source?.kind === 'factory-task')
    expect(assignment).toBeDefined()
    expect(JSON.stringify(assignment?.data)).toContain('## Dependency handoff')
    expect(capturedSession?.events.some(event => event.type === 'tool/result')).toBe(true)
  })

  it('reminds an observed Agent once, settles its report, and leaves later conversation alone', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-factory-observed-completion-'))
    const projectPath = join(root, 'repo')
    await mkdir(projectPath)
    const adapter = new ScriptedAdapter([
      textResponse('Analysis and verification are complete.'),
      finishCall('Inspected the APIs and verified the findings.', 'observed-finish'),
      textResponse('Inspected the APIs and verified the findings.'),
      textResponse('Happy to discuss the result further.'),
    ])
    const { context, domain } = await schedulerHarness(projectPath, adapter)
    const handle = await context.agents.create({
      sessionId: SessionId('observed-completion'),
      meta: { cwd: projectPath },
      agentOptions: { provider: 'mock', model: 'mock-model' },
    })

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect the APIs and report the result.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    await waitFor(async () => (await domain.readStore()).document.runs[0]?.status === 'succeeded')

    const completed = await domain.readStore()
    expect(completed.document.tasks[0]?.output?.summary).toBe('Inspected the APIs and verified the findings.')
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[0]?.tools?.some(tool => tool.name === 'factory_finish')).toBe(false)
    expect(adapter.requests[0]?.system ?? '').not.toContain(FactoryTools.FACTORY_FINISH_REMINDER)
    expect(adapter.requests[1]?.tools?.some(tool => tool.name === 'factory_finish')).toBe(true)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain(FactoryTools.FACTORY_FINISH_REMINDER)
    const reminders = handle.agent.session.events.filter(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'dsh-factory')
    expect(reminders).toHaveLength(1)
    expect(JSON.stringify(reminders[0]?.data)).toContain(FactoryTools.FACTORY_FINISH_REMINDER)

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Thanks. Explain one part conversationally.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(4)
    expect(adapter.requests[3]?.tools?.some(tool => tool.name === 'factory_finish')).toBe(false)
    expect(handle.agent.session.events.filter(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'dsh-factory')).toHaveLength(1)
    await handle.dispose()
  })

  it('keeps dependent work queued until a pending human question is answered', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-factory-human-gate-'))
    const projectPath = join(root, 'repo')
    await mkdir(projectPath)
    const question = {
      id: 'release', question: 'Should the dependent release step continue?',
      options: [{ label: 'Continue' }, { label: 'Stop' }],
    }
    const adapter = new ScriptedAdapter([
      toolCalls([
        { name: 'ask_user_question', value: { questions: [question] }, callId: 'factory-human-question' },
        {
          name: 'factory_finish', callId: 'factory-premature-finish',
          value: { outcome: 'succeeded', summary: 'Premature without the human answer' },
        },
      ]),
      finishCall('Human-approved implementation verified', 'factory-root-finish'),
      textResponse('Root task done.'),
      finishCall('Dependent verification complete', 'factory-dependent-finish'),
      textResponse('Dependent task done.'),
    ])
    const { context, domain } = await schedulerHarness(projectPath, adapter, 2)
    const requested = Promise.withResolvers<AskUserQuestionRequest>()
    const answer = Promise.withResolvers<AskUserQuestionAnswer>()
    context.userQuestions.registerProvider({
      ask(request) {
        requested.resolve(request)
        return answer.promise
      },
    })
    const sessions: Array<{ events: readonly { type: string; data: unknown }[] }> = []
    context.on('agent/created', ({ agent }) => { sessions.push(agent.session) })

    await domain.updateProject({
      projectPath,
      settings: {
        model: 'mock:workspace-model', titleModel: 'mock:title-model', autoTitle: false,
        lane: { mode: 'current' },
      },
    })
    const rootSnapshot = await domain.createTask({
      projectPath, title: 'Implementation', prompt: 'Implement, then ask before completion.',
    })
    const implementation = rootSnapshot.document.tasks.find(task => task.title === 'Implementation')!
    const dependentSnapshot = await domain.createTask({
      projectPath, title: 'Release', prompt: 'Run only after implementation.', dependencyIds: [implementation.id],
    })
    const release = dependentSnapshot.document.tasks.find(task => task.title === 'Release')!
    const grouped = await domain.groupTasks({
      taskIds: [implementation.id, release.id], title: 'Human-gated release',
      expectedRevision: dependentSnapshot.revision,
    })
    const flow = grouped.document.flows.find(candidate => candidate.title === 'Human-gated release')!
    await domain.startFlow({ flowId: flow.id, expectedRevision: grouped.revision })

    const request = await requested.promise
    expect(request.questions).toEqual([question])
    expect(request.agent?.id).toMatch(/^factory-/u)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(
      expect.arrayContaining(['ask_user_question', 'factory_finish']),
    )
    await new Promise(resolve => setTimeout(resolve, 250))
    const pending = await domain.readStore()
    expect(pending.document.runs).toHaveLength(1)
    expect(sessions).toHaveLength(1)
    expect(pending.document.runs[0]?.status).toBe('running')
    expect(pending.document.tasks.find(task => task.id === implementation.id)?.status).toBe('running')
    expect(pending.document.tasks.find(task => task.id === release.id)?.status).toBe('queued')

    answer.resolve({ answers: [{ id: 'release', selected: ['Continue'] }] })
    await waitFor(async () => {
      const stored = await domain.readStore()
      return stored.document.tasks.find(task => task.id === implementation.id)?.status === 'succeeded'
        && stored.document.tasks.find(task => task.id === release.id)?.status === 'succeeded'
    })

    const settled = await domain.readStore()
    expect(settled.document.runs.map(run => run.status)).toEqual(['succeeded', 'succeeded'])
    expect(settled.document.tasks.find(task => task.id === implementation.id)?.output?.summary)
      .toBe('Human-approved implementation verified')
    expect(settled.document.tasks.find(task => task.id === release.id)?.output?.summary)
      .toBe('Dependent verification complete')
    expect(adapter.requests).toHaveLength(5)
    expect(JSON.stringify(sessions[0]?.events)).toContain(
      'factory_finish must be called in a later model step after ask_user_question returns',
    )
    const assignment = sessions[0]?.events.find(event =>
      event.type === 'user/message'
      && (event.data as { source?: { kind?: string } }).source?.kind === 'factory-task')
    expect(JSON.stringify(assignment?.data)).toContain('call ask_user_question and wait for its result')
  })

  it('applies a mid-run task model change to the next model step', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-factory-model-switch-'))
    const projectPath = join(root, 'repo')
    await mkdir(projectPath)
    const question = {
      id: 'gate', question: 'May the run continue?',
      options: [{ label: 'Continue' }, { label: 'Stop' }],
    }
    const adapter = new ScriptedAdapter([
      toolCall('ask_user_question', { questions: [question] }, 'model-switch-question'),
      finishCall('Completed after the model switch', 'model-switch-finish'),
      textResponse('Done.'),
    ])
    const { context, domain } = await schedulerHarness(projectPath, adapter)
    const requested = Promise.withResolvers<AskUserQuestionRequest>()
    const answer = Promise.withResolvers<AskUserQuestionAnswer>()
    context.userQuestions.registerProvider({
      ask(request) {
        requested.resolve(request)
        return answer.promise
      },
    })

    await domain.updateProject({
      projectPath, settings: { model: 'mock:workspace-model', titleModel: 'mock:title-model', autoTitle: false, lane: { mode: 'current' } },
    })
    const created = await domain.createTask({ projectPath, title: 'Switch routing', prompt: 'Ask, then complete.', enqueue: true })
    const task = created.document.tasks[0]!

    await requested.promise
    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([['mock', 'workspace-model']])

    await domain.updateTask({ taskId: task.id, model: 'mock:switched-model' })
    await new Promise(resolve => setTimeout(resolve, 400))
    answer.resolve({ answers: [{ id: 'gate', selected: ['Continue'] }] })

    await waitFor(async () => (await domain.readStore()).document.tasks[0]?.status === 'succeeded')
    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['mock', 'workspace-model'],
      ['mock', 'switched-model'],
      ['mock', 'switched-model'],
    ])
    const stored = await domain.readStore()
    expect(stored.document.tasks[0]?.output?.summary).toBe('Completed after the model switch')
    expect(stored.document.activities.some(entry => entry.kind === 'task-model-changed' && entry.taskId === task.id)).toBe(true)
  })

  it('auto retries a suddenly failing claim and recovers after the exponential backoff', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-factory-auto-retry-'))
    const projectPath = join(root, 'repo')
    await mkdir(projectPath)
    const adapter = new ScriptedAdapter()
    const { domain, shell } = await schedulerHarness(projectPath, adapter)
    let setupCalls = 0
    shell.run = (spec: ShellExecSpec): Promise<ShellRunResult> => {
      shell.specs.push(spec)
      setupCalls += 1
      const failed = setupCalls === 1
      return Promise.resolve({
        exitCode: failed ? 1 : 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: failed ? 'transient setup boom' : '', truncated: false },
      })
    }

    await domain.updateProject({
      projectPath,
      settings: { model: 'mock:workspace-model', titleModel: 'mock:title-model', autoTitle: false, lane: { mode: 'current' }, setupCommand: 'bun install' },
    })
    await domain.createTask({
      projectPath, title: 'Flaky setup', prompt: 'Recover after a transient setup failure.', enqueue: true,
      retry: { maxRetries: 3, backoffMs: 1_000 },
    })

    await waitFor(async () => {
      const storedNow = await domain.readStore()
      return storedNow.document.tasks[0]?.status === 'queued' && storedNow.document.tasks[0]?.retryCount === 1
    })
    await waitFor(async () => (await domain.readStore()).document.tasks[0]?.status === 'succeeded')
    const stored = await domain.readStore()
    expect(setupCalls).toBe(2)
    expect(stored.document.runs.map(run => [run.attempt, run.status])).toEqual([[1, 'failed'], [2, 'succeeded']])
    expect(stored.document.runs[0]?.failure).toContain('Factory project setup failed')
    expect(stored.document.tasks[0]?.output?.summary).toBe('Implemented and verified')
    expect(stored.document.tasks[0]?.retryAt).toBeUndefined()
    expect(stored.document.tasks[0]?.retryCount).toBeUndefined()
    const backoffs = stored.document.activities.filter(entry => entry.kind === 'run-auto-retry')
    expect(backoffs).toHaveLength(1)
    expect(backoffs[0]?.message).toContain('automatic retry 1 of 3 queued in 1s')
  })
})
