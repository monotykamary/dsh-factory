import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@monotykamary/dsh-agent'
import { admitEncodedImages, type EncodedImageAttachment, type ImageMediaType } from '@monotykamary/dsh-attachment'
import { installModelSelection } from '@monotykamary/dsh-agent'
import type {} from '@monotykamary/dsh-agent-default-model'
import type {} from '@monotykamary/dsh-agent-presets'
import type { Context } from '@monotykamary/cordis'
import { createUserMessage, type ContentBlock } from '@monotykamary/dsh-llm'
import { SessionId } from '@monotykamary/dsh-session'
import * as AskUserQuestionTool from '@monotykamary/dsh-tool-ask-user'
import { boundedText, renderMutation } from '@monotykamary/dsh-tool-session-mutations/ledger'
import type {} from '@monotykamary/dsh-shell'
import type {} from '@monotykamary/dsh-worktree'
import z from '@monotykamary/schemastery'
import { factoryFileMutations, installFactoryCompletionTool, type FactoryCompletionChannel } from 'dsh-factory-tools'
import {
  type FactoryDocument, type FactoryProject, type FactoryRunId, type FactoryTask, type FactoryTaskId,
} from 'dsh-factory-protocol'
import type { FactoryTaskClaim } from 'dsh-factory-domain'
import type {} from 'dsh-factory-domain'

/** Cordis plugin name. */
export const name = 'factory-scheduler'

/** Scheduler execution and cleanup policy. */
export interface Config {
  maxConcurrent?: number
  maxAttempts?: number
  tickMs?: number
  leaseTtlMs?: number
  setupTimeoutMs?: number
  cleanupPolicy?: 'retain' | 'remove-succeeded'
  sweepOlderThanMs?: number
  sweepLimit?: number
  maxDependencyMutations?: number
  maxDependencyContextChars?: number
}

interface ResolvedConfig {
  maxConcurrent: number
  maxAttempts: number
  tickMs: number
  leaseTtlMs: number
  setupTimeoutMs: number
  cleanupPolicy: 'retain' | 'remove-succeeded'
  sweepOlderThanMs: number
  sweepLimit: number
  maxDependencyMutations: number
  maxDependencyContextChars: number
}

interface ActiveRun {
  taskId: FactoryTaskId
  runId: FactoryRunId
  done: Promise<void>
  handle?: AgentHandle
  channel?: FactoryCompletionChannel
  /** Live routing ref shared with the Agent; a task model change swaps the next model step. */
  selection?: ModelSelectionRef
  lastError?: unknown
  notify: (() => void) | undefined
}

/** Logged provenance for an Agent message assigned by Factory. */
export interface FactoryTaskMessageSource {
  kind: 'factory-task'
  taskId: FactoryTaskId
  runId: FactoryRunId
}

declare module '@monotykamary/dsh-llm' {
  interface MessageSourceMap {
    'factory-task': FactoryTaskMessageSource
  }
}

export { factoryFileMutations } from 'dsh-factory-tools'

/**
 * Render direct predecessor results and mutation receipts for the next task's logged assignment.
 * @param document - Current durable Factory document.
 * @param task - Task receiving dependency context.
 * @param bounds - Maximum receipt count and UTF-16 characters.
 * @returns Bounded handoff text, or `None.` for a root task.
 */
export function dependencyHandoff(
  document: FactoryDocument,
  task: FactoryTask,
  bounds: { maxMutations: number; maxChars: number },
): string {
  const dependencies = task.dependencyIds.flatMap(id => document.tasks.find(candidate => candidate.id === id) ?? [])
  if (dependencies.length === 0) return 'None.'
  const lines: string[] = []
  let includedMutations = 0
  let omittedMutations = 0
  for (const dependency of dependencies) {
    lines.push(`### ${dependency.identifier}: ${dependency.title}`)
    const output = dependency.output
    if (output === undefined) {
      lines.push('No terminal output is available.')
      continue
    }
    lines.push(`Summary: ${output.summary}`)
    if (output.details !== undefined && output.details.trim() !== '') lines.push(`Details: ${output.details}`)
    if (output.artifacts.length > 0) lines.push(`Artifacts: ${output.artifacts.join(', ')}`)
    if (output.mutations.length === 0) {
      lines.push('Mutation ledger: no receipt-aware file changes.')
      continue
    }
    lines.push('Mutation ledger (shell and external changes are not included):')
    for (const mutation of [...output.mutations].sort((left, right) => left.commitOrder - right.commitOrder)) {
      if (includedMutations >= bounds.maxMutations) {
        omittedMutations += 1
        continue
      }
      includedMutations += 1
      lines.push(renderMutation(mutation))
    }
  }
  if (omittedMutations > 0) lines.push(`[${String(omittedMutations)} additional mutation receipts omitted]`)
  const complete = lines.join('\n\n')
  if (complete.length <= bounds.maxChars) return complete
  const marker = `[Dependency handoff truncated at ${String(bounds.maxChars)} characters]`
  if (marker.length >= bounds.maxChars) return boundedText(marker, 0, bounds.maxChars).text
  const body = boundedText(complete, 0, bounds.maxChars - marker.length - 1).text
  return `${body}\n${marker}`
}

/** Existing capabilities required by the behavior plugin. */
export const inject = ['factory', 'agents', 'agentDefaultModel', 'agentPresets', 'attachments', 'llm', 'sessions', 'shell', 'systemPrompt', 'userQuestions', 'worktrees', 'tools']

/** Runtime validation for scheduler policy. */
export const Config: z<Config> = z.object({
    maxConcurrent: z.number().step(1).min(1).default(3),
    maxAttempts: z.number().step(1).min(1).default(3),
    tickMs: z.number().step(1).min(100).default(1_000),
    leaseTtlMs: z.number().step(1).min(1_000).default(10_000),
    setupTimeoutMs: z.number().step(1).min(1_000).default(120_000),
    cleanupPolicy: z.union(['retain', 'remove-succeeded'] as const).default('retain'),
    sweepOlderThanMs: z.number().step(1).min(60_000).default(604_800_000),
    sweepLimit: z.number().step(1).min(1).default(8),
    maxDependencyMutations: z.number().step(1).min(1).default(32),
    maxDependencyContextChars: z.number().step(1).min(1_000).default(24_000),
})

/** Leader-elected dependency and checkout-lane scheduler. */
class FactoryScheduler {
  private readonly config: ResolvedConfig
  private readonly active = new Map<FactoryTaskId, ActiveRun>()
  private pumping: Promise<void> | undefined
  private stopped = false
  private lastSweep = 0

  /**
   * Start periodic and event-driven reconciliation.
   * @param ctx - Cordis context carrying DSH execution capabilities.
   * @param config - Concurrency, lease, setup, and cleanup policy.
   */
  constructor(private readonly ctx: Context, config: Config) {
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 3, maxAttempts: config.maxAttempts ?? 3,
      tickMs: config.tickMs ?? 1_000, leaseTtlMs: config.leaseTtlMs ?? 10_000,
      setupTimeoutMs: config.setupTimeoutMs ?? 120_000, cleanupPolicy: config.cleanupPolicy ?? 'retain',
      sweepOlderThanMs: config.sweepOlderThanMs ?? 604_800_000, sweepLimit: config.sweepLimit ?? 8,
      maxDependencyMutations: config.maxDependencyMutations ?? 32, maxDependencyContextChars: config.maxDependencyContextChars ?? 24_000,
    }
    const schedule = (): void => { void this.schedulePump() }
    ctx.on('factory/changed', schedule, { global: true })
    ctx.on('agent/status', ({ agent }) => { this.notifyAgent(agent) }, { global: true })
    ctx.on('agent/error', ({ agent, error }) => {
      const active = [...this.active.values()].find(value => value.handle?.agent === agent)
      if (active !== undefined) { active.lastError = error; active.notify?.() }
    }, { global: true })
    const timer = setInterval(schedule, this.config.tickMs)
    timer.unref()
    ctx.effect(() => async () => {
      this.stopped = true
      clearInterval(timer)
      await this.pumping
      for (const active of this.active.values()) {
        active.handle?.agent.cancel({ kind: 'disposed' })
        active.notify?.()
      }
      await Promise.allSettled([...this.active.values()].map(active => active.done))
      await ctx.factory.releaseSchedulerLease()
    }, 'factory-scheduler: drain Agents and release leader lease')
    schedule()
  }

  private schedulePump(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.pumping !== undefined) return this.pumping
    this.pumping = this.pump().catch((error: unknown) => {
      this.ctx.logger.warn(`Factory scheduler reconciliation failed: ${this.message(error)}`)
    }).finally(() => { this.pumping = undefined })
    return this.pumping
  }

  private async pump(): Promise<void> {
    if (!await this.ctx.factory.acquireSchedulerLease(this.config.leaseTtlMs)) return
    await this.ctx.factory.activateDueAutomations()
    const snapshot = await this.ctx.factory.snapshot()
    await this.ctx.factory.requeueOrphanedRuns(
      new Set(snapshot.agents.map(agent => agent.sessionId)),
      new Set([...this.active.values()].map(active => active.runId)),
      this.config.maxAttempts,
    )
    await this.reconcileActive()
    const claims = await this.ctx.factory.claimReadyTasks(this.config.maxConcurrent)
    for (const claim of claims) this.start(claim)
    if (Date.now() - this.lastSweep >= this.config.sweepOlderThanMs) {
      this.lastSweep = Date.now()
      await this.sweep(snapshot.document)
    }
  }

  private start(claim: FactoryTaskClaim): void {
    if (this.active.has(claim.task.id)) return
    const active: ActiveRun = { taskId: claim.task.id, runId: claim.run.id, done: Promise.resolve(), notify: undefined }
    this.active.set(claim.task.id, active)
    active.done = this.executeClaim(claim, active).catch(async (error: unknown) => {
      this.ctx.logger.warn(`Factory ${claim.task.identifier} failed to execute: ${this.message(error)}`)
      try { await this.ctx.factory.failRun(claim.run.id, error) } catch (settleError: unknown) {
        this.ctx.logger.error(`Factory ${claim.task.identifier} failure could not be persisted: ${this.message(settleError)}`)
      }
    }).finally(async () => {
      active.notify?.()
      if (active.handle !== undefined) await active.handle.dispose()
      this.active.delete(claim.task.id)
      if (!this.stopped) void this.schedulePump()
    })
  }

  private async executeClaim(claim: FactoryTaskClaim, active: ActiveRun): Promise<void> {
    const checkoutPath = await this.allocateCheckout(claim)
    if (claim.project.settings.setupCommand !== undefined) await this.runSetup(claim.project.settings.setupCommand, checkoutPath)
    const selection = this.selection(claim.task, claim.project)
    const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
    const presetId = claim.task.preset ?? this.ctx.agentPresets.defaultId
    let channel: FactoryCompletionChannel | undefined
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(`factory-${claim.run.id}`),
      meta: { cwd: checkoutPath, agentPreset: presetId },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, presetId)
        installModelSelection(agentCtx, selectionRef)
        await agentCtx.plugin(AskUserQuestionTool)
        channel = installFactoryCompletionTool(agentCtx)
      },
    })
    if (channel === undefined) throw new Error('Factory completion channel was not installed during Agent setup')
    active.handle = handle
    active.channel = channel
    active.selection = selectionRef
    await this.ctx.factory.bindRun(claim.run.id, handle.agent.id, checkoutPath)
    handle.agent.followup(createUserMessage({
      content: await this.taskContent(claim),
      source: { kind: 'factory-task', taskId: claim.task.id, runId: claim.run.id },
    }))
    await this.monitor(claim, active)
    if (this.config.cleanupPolicy === 'remove-succeeded' && (await this.taskState(claim.task.id))?.status === 'succeeded') {
      await this.cleanupCheckout(claim, checkoutPath)
    }
  }

  private async monitor(claim: FactoryTaskClaim, active: ActiveRun): Promise<void> {
    const handle = active.handle
    const channel = active.channel
    if (handle === undefined || channel === undefined) throw new Error('Factory run monitor started before Agent setup')
    while (true) {
      await handle.agent.whenIdle()
      if (this.stopped) {
        await this.ctx.factory.markRunWaiting(claim.run.id, 'Factory scheduler reloaded while this Session was idle.')
        return
      }
      if (active.lastError !== undefined) {
        await this.ctx.sessions.flush(handle.agent.session)
        await this.ctx.factory.failRun(claim.run.id, active.lastError)
        return
      }
      const report = channel.consume()
      if (report !== undefined) {
        await this.ctx.sessions.flush(handle.agent.session)
        await this.ctx.factory.finishRun(claim.run.id, { ...report, mutations: factoryFileMutations(handle.agent.session.events) })
        if (report.outcome !== 'blocked') return
      } else {
        await this.ctx.factory.markRunWaiting(claim.run.id)
      }
      while (handle.agent.status === 'idle') {
        if (this.stopped) return
        const state = await this.taskState(claim.task.id)
        if (state === undefined || state.activeRunId !== claim.run.id
          || ['cancelled', 'failed', 'succeeded'].includes(state.status)) return
        await this.waitForWake(active)
      }
    }
  }

  private async reconcileActive(): Promise<void> {
    const stored = await this.ctx.factory.readStore()
    const tasks = new Map(stored.document.tasks.map(task => [task.id, task]))
    for (const active of this.active.values()) {
      const task = tasks.get(active.taskId)
      if (task?.status === 'cancelled') {
        active.handle?.agent.cancel({ kind: 'user' })
        active.notify?.()
        continue
      }
      if (task === undefined || active.selection === undefined) continue
      const project = stored.document.projects.find(candidate => candidate.id === task.projectId)
      if (project === undefined) continue
      const next = this.selection(task, project)
      const current = active.selection.current
      if (current === undefined
        || next.provider !== current.provider
        || next.model !== current.model
        || next.reasoningEffort !== current.reasoningEffort) {
        active.selection.current = next
      }
    }
  }

  private async allocateCheckout(claim: FactoryTaskClaim): Promise<string> {
    if (claim.task.lane.mode === 'current') return claim.project.mainPath
    if (claim.task.lane.mode === 'reuse') {
      if (claim.task.lane.reuseTaskId === undefined) throw new Error(`${claim.task.identifier} reuse lane names no predecessor task`)
      const stored = await this.ctx.factory.readStore()
      const source = stored.document.tasks.find(task => task.id === claim.task.lane.reuseTaskId)
      if (source?.output?.checkoutPath === undefined) throw new Error(`${claim.task.identifier} reuse source has no checkout output`)
      return source.output.checkoutPath
    }
    if (claim.task.automation?.trigger.kind === 'recurring') {
      const stored = await this.ctx.factory.readStore()
      const previousPath = claim.task.output?.checkoutPath ?? stored.document.runs.toReversed().find(run => run.taskId === claim.task.id && run.checkoutPath !== undefined)?.checkoutPath
      if (previousPath !== undefined) {
        const existing = (await this.ctx.worktrees.list({ cwd: claim.project.mainPath })).find(checkout => checkout.path === previousPath)
        if (existing !== undefined) return existing.path
      }
    }
    const baseRef = claim.task.lane.baseRef !== undefined
      ? { ref: claim.task.lane.baseRef } as const
      : claim.project.defaultRef !== undefined ? { ref: claim.project.defaultRef } as const : 'head' as const
    const checkout = await this.ctx.worktrees.create({
      cwd: claim.project.mainPath, label: `${claim.task.identifier}-${claim.task.title}`, baseRef,
    })
    return checkout.path
  }

  private async runSetup(command: string, checkoutPath: string): Promise<void> {
    const result = await this.ctx.shell.run(this.ctx.shell.resolve({ command, workdir: checkoutPath, timeoutMs: this.config.setupTimeoutMs }))
    if (result.exitCode !== 0 || result.signal !== null) {
      const diagnostic = result.stderr.text.trim() || result.stdout.text.trim() || `exit ${result.exitCode ?? result.signal}`
      throw new Error(`Factory project setup failed: ${diagnostic}`)
    }
  }

  private selection(task: FactoryTask, project: FactoryProject): ModelSelection {
    const selected = this.ctx.agentDefaultModel.currentSelection()
    const model = task.model?.trim() || project.settings.model?.trim()
    if (model === undefined) return selected
    const boundary = model.indexOf(':')
    return boundary <= 0
      ? { ...selected, model }
      : { ...selected, provider: model.slice(0, boundary), model: model.slice(boundary + 1) }
  }

  private async taskContent(claim: FactoryTaskClaim): Promise<ContentBlock[]> {
    const stored = await this.ctx.factory.readStore()
    const dependencyText = dependencyHandoff(stored.document, claim.task, {
      maxMutations: this.config.maxDependencyMutations,
      maxChars: this.config.maxDependencyContextChars,
    })
    const text = [
      `# Factory assignment ${claim.task.identifier}: ${claim.task.title}`,
      '', claim.task.description, '', claim.task.prompt, '',
      `Project: ${claim.project.title}`, `Checkout: ${claim.task.lane.mode}`, '',
      '## Dependency handoff', dependencyText, '',
      'Complete only this assigned node. Inspect the workspace and execute direct verification. If an answer or decision from the human is required before the work is honestly complete, call ask_user_question and wait for its result; never emit factory_finish in the same model response or while that answer is outstanding. After the answer, continue the work and verify it before calling factory_finish exactly once with succeeded, failed, or blocked. Use blocked only when a direct question cannot resolve the intervention. Do not publish or remove worktrees unless this task explicitly says so.',
    ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n')
    const encoded = claim.task.attachments.map((attachment): EncodedImageAttachment => {
      const match = /^data:([^;,]+);base64,(.+)$/u.exec(attachment.dataUrl)
      if (match?.[1] === undefined || match[2] === undefined) throw new Error(`Factory attachment ${attachment.name} is malformed`)
      return { mediaType: match[1] as ImageMediaType, data: match[2], name: attachment.name }
    })
    const refs = await admitEncodedImages(this.ctx.attachments, encoded)
    return [{ type: 'text', text }, ...refs.map(attachment => ({ type: 'image' as const, attachment }))]
  }

  private waitForWake(active: ActiveRun): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { active.notify = undefined; resolve() }, this.config.tickMs)
      timer.unref()
      active.notify = () => { clearTimeout(timer); active.notify = undefined; resolve() }
    })
  }

  private notifyAgent(agent: Agent): void {
    for (const active of this.active.values()) if (active.handle?.agent === agent) active.notify?.()
  }

  private async taskState(id: FactoryTaskId): Promise<FactoryTask | undefined> {
    return (await this.ctx.factory.readStore()).document.tasks.find(task => task.id === id)
  }

  private async cleanupCheckout(claim: FactoryTaskClaim, path: string): Promise<void> {
    if (claim.task.lane.mode !== 'isolated') return
    const stored = await this.ctx.factory.readStore()
    const stillNeeded = stored.document.tasks.some(task => task.lane.reuseTaskId === claim.task.id
      && !['succeeded', 'failed', 'cancelled'].includes(task.status))
    if (stillNeeded) return
    try {
      await this.ctx.worktrees.remove({ cwd: claim.project.mainPath, path })
    } catch (error: unknown) {
      this.ctx.logger.warn(`Factory preserved checkout ${path}: ${this.message(error)}`)
    }
  }

  private async sweep(document: FactoryDocument): Promise<void> {
    const tasks = new Map(document.tasks.map(task => [task.id, task]))
    const protectedProjects = new Set(document.tasks.flatMap((task) => {
      if (task.lane.reuseTaskId === undefined || ['succeeded', 'failed', 'cancelled'].includes(task.status)) return []
      const source = tasks.get(task.lane.reuseTaskId)
      return source?.output?.checkoutPath === undefined ? [] : [task.projectId]
    }))
    for (const project of document.projects) {
      if (protectedProjects.has(project.id)) continue
      try {
        await this.ctx.worktrees.sweep({ cwd: project.mainPath, olderThanMs: this.config.sweepOlderThanMs, limit: this.config.sweepLimit })
      } catch (error: unknown) {
        this.ctx.logger.warn(`Factory checkout sweep skipped for ${project.mainPath}: ${this.message(error)}`)
      }
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Start the scheduler for this plugin fiber. */
export function apply(ctx: Context, config: Config): void {
  new FactoryScheduler(ctx, config)
}
