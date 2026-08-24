import type { Agent } from '@monotykamary/dsh-agent'
import type { Context } from '@monotykamary/cordis'
import { createUserMessage, type MessageSource } from '@monotykamary/dsh-llm'
import type { SessionEvent } from '@monotykamary/dsh-session'
import { defineTool } from '@monotykamary/dsh-tools'
import { mutationLedger } from '@monotykamary/dsh-tool-session-mutations/ledger'
import {
  type FactoryFileMutation, type FactoryFinishReport, type FactoryRunId,
} from 'dsh-factory-protocol'
import type {} from 'dsh-factory-domain'

const completionOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const REMINDER_SOURCE: MessageSource = {
  kind: 'plugin', plugin: 'dsh-factory', form: 'notice', summary: 'Factory completion',
}

/** Logged next-step context added only when an active Factory run reaches a normal stop without a report. */
export const FACTORY_FINISH_REMINDER = 'The active Factory task has not been settled. If the assigned work is complete, call factory_finish now with the verified outcome and a concise summary; do not repeat the completed response. If work remains, continue it instead. Do not call factory_finish while a human answer is outstanding.'

/** Per-run handoff between the model-visible completion tool and run settlement. */
export interface FactoryCompletionChannel {
  /** Read and clear the first report submitted since the previous consume. */
  consume(): FactoryFinishReport | undefined
  /** Read the pending report without clearing it. */
  peek(): FactoryFinishReport | undefined
  /** Whether a report is waiting for the current turn to settle. */
  pending(): boolean
  /**
   * Add the one per-turn completion reminder when this stop remains unreported.
   * @param agent - Agent reaching its normal turn-stop boundary.
   * @param turn - Turn about to stop.
   * @returns whether reminder context was injected into another step.
   */
  remindAtStop(agent: Agent, turn: number): boolean
  /** Remove the scoped tool and reminder listener. */
  dispose(): void
}

/**
 * Normalize a Session's receipt-aware mutations for durable Factory output.
 * @param events - Complete settled Session events.
 * @returns commit-ordered mutations detached from the Session log.
 */
export function factoryFileMutations(events: readonly SessionEvent[]): FactoryFileMutation[] {
  return mutationLedger(events).map(mutation => ({
    commitOrder: mutation.commitOrder,
    path: mutation.path,
    operation: mutation.operation,
    additions: mutation.additions,
    deletions: mutation.deletions,
    beforeSha256: mutation.beforeSha256,
    afterSha256: mutation.afterSha256,
    diffs: mutation.diffs.map(diff => ({ path: mutation.path, oldText: diff.oldText, newText: diff.newText ?? '' })),
  }))
}

function endedAtMaxTokens(agent: Agent, turn: number): boolean {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type !== 'assistant/chunk'
      || event.data.turn !== turn
      || event.data.chunk.type !== 'finish') continue
    return event.data.chunk.reason.kind === 'max-tokens'
  }
  return false
}

/** Register `factory_finish` and an append-only missing-report reminder in one Agent scope. */
export function installFactoryCompletionTool(ctx: Context): FactoryCompletionChannel {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('factory_finish requires the DSH ToolRuntime')
  let report: FactoryFinishReport | undefined
  let lastRemindedTurn: number | undefined
  let lastReportedTurn: number | undefined
  let disposed = false

  const disposeTool = tools.register(defineTool({
    name: 'factory_finish',
    description: 'Report the assigned Factory task outcome exactly once after verification and after every required human answer has been received. Never emit this tool in the same model response as ask_user_question. Factory commits it only after the response reaches its completion boundary.',
    parameters: {
      outcome: { type: 'string', required: true, enum: ['succeeded', 'failed', 'blocked'], description: 'succeeded after verification, failed for a terminal defect, or blocked only when a direct ask_user_question cannot resolve the required intervention.' },
      summary: { type: 'string', required: true, description: 'Concise result or blocker summary.' },
      details: { type: 'string', description: 'Supporting details, failures, or next action.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths, URLs, or identifiers produced by the task.' },
    },
    output: completionOutput,
    execute(args, exec) {
      const location = exec.location
      const sharesQuestionStep = exec.agent?.session.events.some(event =>
        (location !== undefined
          && event.type === 'assistant/message'
          && event.data.turn === location.turn
          && event.data.step === location.step
          && event.data.message.content.some(block => block.type === 'tool-call' && block.name === 'ask_user_question'))
        || (event.type === 'tool/code-dispatch-start'
          && event.data.rootCallId === exec.rootCallId
          && event.data.name === 'ask_user_question')) === true
      if (sharesQuestionStep) {
        throw new Error('factory_finish must be called in a later model step after ask_user_question returns; wait for and use the human answer first')
      }
      if (report !== undefined) throw new Error('factory_finish already has a report pending for this turn')
      report = {
        outcome: args.outcome, summary: args.summary,
        ...(args.details === undefined ? {} : { details: args.details }),
        ...(args.artifacts === undefined ? {} : { artifacts: args.artifacts }),
      }
      lastReportedTurn = location?.turn
      return Promise.resolve(`Factory ${args.outcome} report accepted; finish this turn with the concise user-facing result and do not start new work.`)
    },
    presentCall: args => ({ card: 'generic', title: `Report Factory task ${args.outcome}`, kind: 'edit', rawInput: args.summary }),
  }))

  const remindAtStop = (agent: Agent, turn: number): boolean => {
    if (disposed || report !== undefined || lastReportedTurn === turn
      || lastRemindedTurn === turn || endedAtMaxTokens(agent, turn)) return false
    lastRemindedTurn = turn
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: FACTORY_FINISH_REMINDER }],
      source: REMINDER_SOURCE,
    }))
    return true
  }

  const disposeReminder = ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    remindAtStop(agent, turn)
  })

  return {
    consume() { const value = report; report = undefined; return value },
    peek() { return report },
    pending() { return report !== undefined },
    remindAtStop,
    dispose() {
      if (disposed) return
      disposed = true
      disposeReminder()
      disposeTool()
    },
  }
}

interface ObservedCompletionBinding {
  readonly runId: FactoryRunId
  readonly channel: FactoryCompletionChannel
}

function hasSchedulerAssignment(agent: Agent): boolean {
  return agent.session.events.some(event => event.type === 'user/message'
    && (event.data.source as { kind: string }).kind === 'factory-task')
}

/** Install conditional completion tools and settlement for independently observed Sessions. */
export function installObservedCompletionCoordinator(ctx: Context): void {
  const bindings = new Map<Agent, ObservedCompletionBinding>()
  let stopped = false

  const release = (agent: Agent): void => {
    const binding = bindings.get(agent)
    if (binding === undefined) return
    bindings.delete(agent)
    binding.channel.dispose()
  }

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    if (stopped || hasSchedulerAssignment(agent)) return
    let runId: FactoryRunId | undefined
    try {
      const run = await ctx.factory.activeObservedRun(agent.id)
      if (stopped) return
      if (run === undefined) {
        release(agent)
        return
      }
      runId = run.id
      let binding = bindings.get(agent)
      if (binding?.runId !== run.id) {
        release(agent)
        binding = { runId: run.id, channel: installFactoryCompletionTool(agent.ctx) }
        bindings.set(agent, binding)
      }
      const report = binding.channel.peek()
      if (report === undefined) {
        binding.channel.remindAtStop(agent, turn)
        return
      }
      await ctx.sessions.flush(agent.session)
      await ctx.factory.finishRun(run.id, {
        ...report,
        mutations: factoryFileMutations(agent.session.events),
      })
      binding.channel.consume()
      if (report.outcome !== 'blocked') release(agent)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const binding = bindings.get(agent)
      if (runId !== undefined && binding?.channel.pending() === true) {
        try {
          await ctx.factory.failRun(runId, new Error(`Observed completion settlement failed: ${message}`))
          release(agent)
        } catch (settlementError: unknown) {
          ctx.logger.error(`Factory could not persist observed completion failure: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`)
        }
      }
      ctx.logger.warn(`Factory observed completion failed: ${message}`)
    }
  }, { global: true })

  ctx.on('agent/disposed', ({ agent }) => { release(agent) }, { global: true })
  ctx.effect(() => () => {
    stopped = true
    for (const agent of [...bindings.keys()]) release(agent)
  }, 'factory-tools: observed completion bindings')
}
