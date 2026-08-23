import type { Context } from '@monotykamary/cordis'
import { defineTool } from '@monotykamary/dsh-tools'
import {
  FactoryFlowId, FactoryTaskId,
  type FactoryAutomationSpec, type FactoryFinishReport, type FactoryLaneSpec, type FactorySnapshot,
} from 'dsh-factory-protocol'
import type {} from '@monotykamary/dsh-skill'
import type {} from 'dsh-factory-domain'

/** Cordis plugin name. */
export const name = 'factory-tools'
/** Existing model tool, skill, and Factory services receive contributions. */
export const inject = ['tools', 'skills', 'factory']

const textOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Per-run handoff between the model-visible completion tool and scheduler settlement. */
export interface FactoryCompletionChannel {
  /** Read and clear the first report submitted since the previous consume. */
  consume(): FactoryFinishReport | undefined
  /** Whether a report is waiting for the current turn to settle. */
  pending(): boolean
}

function automationSpec(
  mode: 'manual' | 'delay' | 'schedule' | 'recurring' | undefined,
  delayMinutes: number | undefined,
  runAt: string | undefined,
  cronExpression: string | undefined,
  enabled?: boolean,
): FactoryAutomationSpec | undefined {
  if (mode === undefined) {
    if (delayMinutes !== undefined || runAt !== undefined || cronExpression !== undefined) throw new Error('automation is required with timing fields')
    return undefined
  }
  if (mode === 'delay' && delayMinutes === undefined) throw new Error('delay_minutes is required for delay automation')
  if (mode === 'schedule' && (runAt === undefined || runAt.trim() === '')) throw new Error('run_at is required for schedule automation')
  if (mode === 'recurring' && (cronExpression === undefined || cronExpression.trim() === '')) throw new Error('cron_expression is required for recurring automation')
  const trigger = mode === 'manual'
    ? { kind: 'manual' as const }
    : mode === 'delay'
      ? { kind: 'delay' as const, delayMinutes: delayMinutes as number }
      : mode === 'schedule'
        ? { kind: 'schedule' as const, at: runAt as string }
        : { kind: 'recurring' as const, schedule: { kind: 'cron' as const, expression: cronExpression as string } }
  return { trigger, ...(enabled === undefined ? {} : { enabled }) }
}

function taskLane(mode: 'current' | 'isolated' | 'reuse', reuseTaskId?: string, baseRef?: string): FactoryLaneSpec {
  if (mode === 'reuse' && reuseTaskId === undefined) throw new Error('reuse_task_id is required for a reuse lane')
  if (mode !== 'reuse' && reuseTaskId !== undefined) throw new Error('reuse_task_id is valid only for a reuse lane')
  if (mode !== 'isolated' && baseRef !== undefined) throw new Error('base_ref is valid only for an isolated lane')
  return {
    mode,
    ...(reuseTaskId === undefined ? {} : { reuseTaskId: FactoryTaskId(reuseTaskId) }),
    ...(baseRef === undefined || baseRef.trim() === '' ? {} : { baseRef }),
  }
}

function managementProjection(snapshot: FactorySnapshot): object {
  return {
    revision: snapshot.revision,
    defaultModel: snapshot.defaultModel,
    projects: snapshot.document.projects,
    tasks: snapshot.document.tasks.map(task => ({
      id: task.id, identifier: task.identifier, projectId: task.projectId, flowId: task.flowId,
      title: task.title, description: task.description, prompt: task.prompt, status: task.status,
      priority: task.priority, labels: task.labels, dependencyIds: task.dependencyIds, lane: task.lane,
      preset: task.preset, model: task.model, automation: task.automation, activeRunId: task.activeRunId,
      attachmentNames: task.attachments.map(attachment => attachment.name), commentCount: task.comments.length,
      output: task.output === undefined ? undefined : {
        summary: task.output.summary, artifacts: task.output.artifacts, checkoutPath: task.output.checkoutPath,
        sessionId: task.output.sessionId, completedAt: task.output.completedAt,
      },
    })),
    flows: snapshot.document.flows,
    runs: snapshot.document.runs,
    agents: snapshot.agents,
  }
}

/** Register `factory_finish` in one Agent scope and return its report channel. */
export function installFactoryCompletionTool(ctx: Context): FactoryCompletionChannel {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('factory_finish requires the DSH ToolRuntime')
  let report: FactoryFinishReport | undefined
  tools.register(defineTool({
    name: 'factory_finish',
    description: 'Report the assigned Factory task outcome exactly once after verification and after every required human answer has been received. Never emit this tool in the same model response as ask_user_question. The scheduler commits it only after this turn reaches idle.',
    parameters: {
      outcome: { type: 'string', required: true, enum: ['succeeded', 'failed', 'blocked'], description: 'succeeded after verification, failed for a terminal defect, or blocked only when a direct ask_user_question cannot resolve the required intervention.' },
      summary: { type: 'string', required: true, description: 'Concise result or blocker summary.' },
      details: { type: 'string', description: 'Supporting details, failures, or next action.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths, URLs, or identifiers produced by the task.' },
    },
    output: textOutput,
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
      return Promise.resolve(`Factory ${args.outcome} report accepted; finish this turn without starting new work.`)
    },
    presentCall: args => ({ card: 'generic', title: `Report Factory task ${args.outcome}`, kind: 'edit', rawInput: args.summary }),
  }))
  return {
    consume() { const value = report; report = undefined; return value },
    pending() { return report !== undefined },
  }
}

const FACTORY_SKILL = `# Factory operating guide

Factory is a durable dependency graph, not a replacement for your current Session. Use factory_list before changing work you did not create; its revision, flow membership, task fields, recurring run history, and live Session ids support subsequent mutations. Ordinary tasks remain drafts unless enqueue is explicitly true. Their model, checkout, setup, title-generation policy, and metadata prompts inherit from workspace settings. Tasks become runnable only after all dependency tasks succeed. Recurring tasks remain Scheduled between occurrences and each terminal run appears unread in Triage. Checkout lanes serialize writers: current uses the project's main checkout, isolated creates a managed worktree, and reuse continues in a predecessor's checkout.

Use factory_update_project to set workspace models, metadata prompts, checkout, and setup policy. Use factory_create_task for durable standalone work instead of leaving an untracked TODO; omit title and description to generate them from the prompt. Build a sequential or parallel flow explicitly: create each task with dependency_ids, then call factory_create_flow with the relationship-complete task ids and a clear title. Use factory_start_flow for a grouped draft's atomic launch, factory_update_task to replace mutable fields or the complete dependency list, factory_attach_session to assign one observed Session, factory_adopt_sessions to sink live Sessions, factory_task to run now, pause, cancel, or retry, and factory_comment to add context. Hard deletion is intentionally unavailable: cancel work to preserve its audit history.

For recurring work, pass automation recurring and a five-field cron_expression to factory_create_task or factory_update_task. The task runs at local host time, returns to Scheduled after success or failure, and retains each result for Triage. When your Session was launched for a Factory run, call ask_user_question if a human answer or decision is required before the work is honestly complete. Its pending result keeps the assigned node nonterminal, so do not call factory_finish until the human answers; then use the answer in a later model step, continue, verify, and report exactly once. Use outcome blocked only when a direct question cannot resolve the intervention. Do not claim success from intent alone. Publishing and cleanup belong in explicit graph tasks and must never be smuggled into an implementation completion report.`

/** Register global Factory management tools and the bundled operating skill. */
export function apply(ctx: Context): void {
  ctx.skills.register({
    name: 'factory', description: 'Operate durable task graphs, grouped flows, checkout lanes, dependencies, and explicit run completion.',
    whenToUse: 'Use for durable follow-up work, grouped or parallel task graphs, or an assigned Factory run.', source: 'bundled', provider: 'dsh-factory', content: FACTORY_SKILL,
  })

  ctx.tools.register(defineTool({
    name: 'factory_list',
    description: 'List complete manageable Factory task fields, grouped flows, recurring run history, and observed live Sessions.',
    parameters: {}, output: textOutput, isConcurrencySafe: () => true,
    async execute() {
      return JSON.stringify(managementProjection(await ctx.factory.snapshot()), null, 2)
    },
    presentCall: () => ({ card: 'generic', title: 'List Factory work', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'factory_create_task',
    description: 'Create a durable standalone Factory task in the calling Agent workspace. Ordinary work remains draft unless enqueued; recurring work remains Scheduled between runs.',
    parameters: {
      title: { type: 'string', description: 'Optional manual title; omission uses project title generation.' }, prompt: { type: 'string', required: true }, description: { type: 'string' },
      priority: { type: 'number', enum: [0, 1, 2, 3, 4] }, labels: { type: 'array', items: { type: 'string' } },
      dependency_ids: { type: 'array', items: { type: 'string' } }, enqueue: { type: 'boolean' },
      automation: { type: 'string', enum: ['manual', 'delay', 'schedule', 'recurring'], description: 'Optional enabled one-shot or recurring queue trigger.' },
      delay_minutes: { type: 'number', description: 'Delay after dependencies succeed; required for delay.' },
      run_at: { type: 'string', description: 'ISO timestamp; required for one-time schedule.' },
      cron_expression: { type: 'string', description: 'Five-field local-time cron; required for recurring.' },
      lane: { type: 'string', enum: ['current', 'isolated'], description: 'Checkout strategy; isolated is the safe default.' },
      base_ref: { type: 'string', description: 'Optional isolated checkout base ref.' },
      preset: { type: 'string' }, model: { type: 'string' },
      finalizer: { type: 'boolean', description: 'Marks cleanup or publish work that runs after ordinary flow tasks settle.' },
      finalizer_policy: { type: 'string', enum: ['success', 'always'] },
      expected_revision: { type: 'number' },
    },
    output: textOutput,
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('factory_create_task requires a calling Agent with a workspace')
      const automation = automationSpec(args.automation, args.delay_minutes, args.run_at, args.cron_expression, true)
      if (args.lane === undefined && args.base_ref !== undefined) throw new Error('lane is required with base_ref')
      const snapshot = await ctx.factory.createTask({
        projectPath: cwd, prompt: args.prompt,
        dependencyIds: (args.dependency_ids ?? []).map(FactoryTaskId), enqueue: args.enqueue ?? false,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.lane === undefined ? {} : { lane: taskLane(args.lane, undefined, args.base_ref) }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(args.labels === undefined ? {} : { labels: args.labels }),
        ...(args.preset === undefined ? {} : { preset: args.preset }), ...(args.model === undefined ? {} : { model: args.model }),
        ...(automation === undefined ? {} : { automation }),
        ...(args.finalizer === undefined ? {} : { finalizer: args.finalizer }),
        ...(args.finalizer_policy === undefined ? {} : { finalizerPolicy: args.finalizer_policy }),
        ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision }),
      })
      const task = snapshot.document.tasks.at(-1)
      return task === undefined ? 'Factory task created.' : `${task.identifier} (${task.id}) created (${task.status}): ${task.title}`
    },
    presentCall: args => ({ card: 'generic', title: `Create Factory task${args.title === undefined ? '' : `: ${args.title}`}`, kind: 'edit', rawInput: args.prompt }),
  }))

  ctx.tools.register(defineTool({
    name: 'factory_create_flow',
    description: 'Group a relationship-complete set of same-workspace standalone or emerging-work tasks into one named flow.',
    parameters: {
      task_ids: { type: 'array', required: true, items: { type: 'string' } },
      title: { type: 'string', required: true }, expected_revision: { type: 'number' },
    },
    output: textOutput,
    async execute(args) {
      const snapshot = await ctx.factory.groupTasks({
        taskIds: args.task_ids.map(FactoryTaskId), title: args.title,
        ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision }),
      })
      const flow = snapshot.document.flows.find(candidate => candidate.kind === 'standard' && candidate.title === args.title)
      return flow === undefined ? 'Factory flow created.' : `Factory flow ${flow.title} (${flow.id}) contains ${String(flow.taskIds.length)} task(s).`
    },
    presentCall: args => ({ card: 'generic', title: `Create Factory flow: ${args.title}`, kind: 'edit', rawInput: args.task_ids.join(', ') }),
  }))

  ctx.tools.register(defineTool({
    name: 'factory_start_flow',
    description: 'Explicitly start one draft Factory flow: queue ordinary nodes and enable its manual, delayed, one-time, or recurring stages atomically.',
    parameters: { flow_id: { type: 'string', required: true }, expected_revision: { type: 'number' } },
    output: textOutput,
    async execute(args) {
      const snapshot = await ctx.factory.startFlow({
        flowId: FactoryFlowId(args.flow_id),
        ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision }),
      })
      const flow = snapshot.document.flows.find(candidate => candidate.id === args.flow_id)
      return flow === undefined ? 'Factory flow started.' : `Factory flow ${flow.title} (${flow.id}) is ${flow.status}.`
    },
    presentCall: args => ({ card: 'generic', title: 'Start Factory flow', kind: 'edit', rawInput: args.flow_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'factory_update_project',
    description: 'Replace the calling workspace Factory defaults for execution model, title model, metadata instructions, checkout, and setup.',
    parameters: {
      model: { type: 'string', required: true, description: 'Concrete provider:model used by inherited task prompts.' },
      title_model: { type: 'string', required: true, description: 'Concrete provider:model used for generated titles and descriptions.' },
      auto_title: { type: 'boolean', required: true },
      title_prompt: { type: 'string', description: 'Optional custom title instruction; empty resets the default.' },
      description_prompt: { type: 'string', description: 'Optional custom description instruction; empty resets the default.' },
      lane: { type: 'string', required: true, enum: ['current', 'isolated'] },
      base_ref: { type: 'string' }, setup_command: { type: 'string' }, expected_revision: { type: 'number' },
    },
    output: textOutput,
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('factory_update_project requires a calling Agent with a workspace')
      if (args.lane !== 'isolated' && args.base_ref !== undefined) throw new Error('base_ref is valid only for an isolated lane')
      const snapshot = await ctx.factory.updateProject({
        projectPath: cwd,
        settings: {
          model: args.model, titleModel: args.title_model, autoTitle: args.auto_title,
          ...(args.title_prompt === undefined || args.title_prompt.trim() === '' ? {} : { titlePrompt: args.title_prompt }),
          ...(args.description_prompt === undefined || args.description_prompt.trim() === '' ? {} : { descriptionPrompt: args.description_prompt }),
          lane: { mode: args.lane, ...(args.base_ref === undefined || args.base_ref.trim() === '' ? {} : { baseRef: args.base_ref }) },
          ...(args.setup_command === undefined || args.setup_command.trim() === '' ? {} : { setupCommand: args.setup_command }),
        },
        ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision }),
      })
      const project = snapshot.document.projects.find(candidate => candidate.mainPath === cwd)
        ?? snapshot.document.projects.at(-1)
      return project === undefined ? 'Factory workspace settings saved.' : `Factory workspace settings saved for ${project.title} (${project.mainPath}).`
    },
    presentCall: () => ({ card: 'generic', title: 'Update Factory workspace settings', kind: 'edit' }),
  }))

  ctx.tools.register(defineTool({
    name: 'factory_adopt_sessions',
    description: 'Place observed live Sessions in each workspace emerging-work flow, or adopt a same-workspace selection directly into a named flow.',
    parameters: {
      session_ids: { type: 'array', required: true, items: { type: 'string' } },
      flow_title: { type: 'string' }, expected_revision: { type: 'number' },
    },
    output: textOutput,
    async execute(args) {
      const snapshot = await ctx.factory.adoptSessions({
        sessionIds: args.session_ids,
        ...(args.flow_title === undefined ? {} : { flowTitle: args.flow_title }),
        ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision }),
      })
      const adopted = snapshot.document.tasks.filter(task => task.status === 'waiting' && task.activeRunId !== undefined)
      return `Factory adopted ${String(args.session_ids.length)} Session(s); waiting tasks: ${adopted.map(task => `${task.identifier} (${task.id})`).join(', ')}.`
    },
    presentCall: args => ({ card: 'generic', title: 'Adopt live Sessions into Factory', kind: 'edit', rawInput: args.session_ids.join(', ') }),
  }))

  ctx.tools.register(defineTool({
    name: 'factory_update_task',
    description: 'Replace mutable fields on one inactive Factory task. dependency_ids replaces the complete list and is also valid alone for a live emerging-work task; empty preset or model clears it.',
    parameters: {
      task_id: { type: 'string', required: true }, title: { type: 'string' }, description: { type: 'string' }, prompt: { type: 'string' },
      priority: { type: 'number', enum: [0, 1, 2, 3, 4] }, labels: { type: 'array', items: { type: 'string' } },
      dependency_ids: { type: 'array', items: { type: 'string' } },
      lane: { type: 'string', enum: ['current', 'isolated', 'reuse'] }, reuse_task_id: { type: 'string' }, base_ref: { type: 'string' },
      preset: { type: 'string' }, model: { type: 'string' },
      automation: { type: 'string', enum: ['none', 'manual', 'delay', 'schedule', 'recurring'] },
      delay_minutes: { type: 'number' }, run_at: { type: 'string' }, cron_expression: { type: 'string' }, expected_revision: { type: 'number' },
    },
    output: textOutput,
    async execute(args) {
      const fields = [args.title, args.description, args.prompt, args.priority, args.labels, args.dependency_ids, args.lane, args.preset, args.model, args.automation]
      if (fields.every(value => value === undefined)) throw new Error('factory_update_task requires at least one mutable field')
      if (args.lane === undefined && (args.reuse_task_id !== undefined || args.base_ref !== undefined)) throw new Error('lane is required with reuse_task_id or base_ref')
      const automation = args.automation === 'none'
        ? null
        : automationSpec(args.automation, args.delay_minutes, args.run_at, args.cron_expression, true)
      const snapshot = await ctx.factory.updateTask({
        taskId: FactoryTaskId(args.task_id),
        ...(args.title === undefined ? {} : { title: args.title }), ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.prompt === undefined ? {} : { prompt: args.prompt }), ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(args.labels === undefined ? {} : { labels: args.labels }),
        ...(args.dependency_ids === undefined ? {} : { dependencyIds: args.dependency_ids.map(FactoryTaskId) }),
        ...(args.lane === undefined ? {} : { lane: taskLane(args.lane, args.reuse_task_id, args.base_ref) }),
        ...(args.preset === undefined ? {} : { preset: args.preset }), ...(args.model === undefined ? {} : { model: args.model }),
        ...(automation === undefined ? {} : { automation }),
        ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision }),
      })
      const task = snapshot.document.tasks.find(candidate => candidate.id === args.task_id)
      return task === undefined ? 'Factory task updated.' : `${task.identifier} updated (${task.status}): ${task.title}`
    },
    presentCall: args => ({ card: 'generic', title: 'Update Factory task', kind: 'edit', rawInput: args.task_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'factory_attach_session',
    description: 'Attach one observed emerging live DSH Session to a draft, queued, or paused Factory task.',
    parameters: {
      task_id: { type: 'string', required: true }, session_id: { type: 'string', required: true }, expected_revision: { type: 'number' },
    },
    output: textOutput,
    async execute(args) {
      const snapshot = await ctx.factory.attachSession({
        taskId: FactoryTaskId(args.task_id), sessionId: args.session_id,
        ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision }),
      })
      const task = snapshot.document.tasks.find(candidate => candidate.id === args.task_id)
      return task === undefined ? 'Factory Session attached.' : `${args.session_id} attached to ${task.identifier} (${task.status}).`
    },
    presentCall: args => ({ card: 'generic', title: 'Attach Session to Factory task', kind: 'edit', rawInput: `${args.session_id} → ${args.task_id}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'factory_comment',
    description: 'Append durable context to a Factory task discussion.',
    parameters: {
      task_id: { type: 'string', required: true }, body: { type: 'string', required: true }, expected_revision: { type: 'number' },
    },
    output: textOutput,
    async execute(args) {
      const snapshot = await ctx.factory.comment({
        taskId: FactoryTaskId(args.task_id), body: args.body,
        ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision }),
      })
      const task = snapshot.document.tasks.find(candidate => candidate.id === args.task_id)
      return task === undefined ? 'Comment added.' : `Comment added to ${task.identifier}.`
    },
    presentCall: args => ({ card: 'generic', title: 'Comment on Factory task', kind: 'edit', rawInput: args.body }),
  }))

  ctx.tools.register(defineTool({
    name: 'factory_task',
    description: 'Run now, resume, pause, cancel, or retry one Factory task. Enqueue runs a Scheduled task immediately without removing its recurrence.',
    parameters: {
      task_id: { type: 'string', required: true }, action: { type: 'string', required: true, enum: ['enqueue', 'pause', 'cancel', 'retry'] },
      expected_revision: { type: 'number' },
    },
    output: textOutput,
    async execute(args) {
      const request = {
        taskId: FactoryTaskId(args.task_id),
        ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision }),
      }
      const snapshot = await ctx.factory[args.action](request)
      const task = snapshot.document.tasks.find(candidate => candidate.id === args.task_id)
      return task === undefined ? `Factory task ${args.action} complete.` : `${task.identifier} is ${task.status}.`
    },
    presentCall: args => ({ card: 'generic', title: `${args.action} Factory task`, kind: 'edit', rawInput: args.task_id }),
  }))
}
