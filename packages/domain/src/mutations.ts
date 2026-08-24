import {
  FactoryAttachmentId, FactoryCommentId, FactoryProcessId, FactoryProjectId, FactoryRunId, FactoryTaskId, deriveFlowStatus,
  type FactoryAttachment, type FactoryAttachmentInput, type FactoryAutomationSpec, type FactoryDocument, type FactoryFlow, type FactoryFlowId,
  type FactoryIntakeId, type FactoryPriority, type FactoryProject, type FactoryRun, type FactoryTask, type FactoryTaskAutomation,
} from 'dsh-factory-protocol'
import { nextFactoryRecurringRun, normalizeFactoryRecurringSchedule } from './schedule.ts'

/** Generate a collision-resistant internal identity. */
export function identity(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

/** Append bounded audit activity. */
export function activity(document: FactoryDocument, limit: number, message: string, kind: string, now: string, task?: FactoryTask, flow?: FactoryFlow): void {
  document.activities.push({
    id: identity('activity'), kind, message, createdAt: now,
    ...(task === undefined ? {} : { taskId: task.id }), ...(flow === undefined ? {} : { flowId: flow.id }),
  })
  if (document.activities.length > limit) document.activities.splice(0, document.activities.length - limit)
}

/** Find a task or fail at the mutation boundary. */
export function expectTask(document: FactoryDocument, id: FactoryTaskId): FactoryTask {
  const task = document.tasks.find(candidate => candidate.id === id)
  if (task === undefined) throw new Error(`Factory task ${id} does not exist`)
  return task
}

/** Find a project or fail at the mutation boundary. */
export function expectProject(document: FactoryDocument, id: FactoryProjectId): FactoryProject {
  const project = document.projects.find(candidate => candidate.id === id)
  if (project === undefined) throw new Error(`Factory project ${id} does not exist`)
  return project
}

/** Recompute every affected flow after task changes. */
export function deriveFlows(document: FactoryDocument, now: string): void {
  const tasks = new Map(document.tasks.map(task => [task.id, task]))
  for (const flow of document.flows) {
    const next = deriveFlowStatus(flow.taskIds.flatMap(id => tasks.get(id) ?? []))
    if (flow.status !== next) {
      flow.status = next
      flow.updatedAt = now
    }
  }
}

/** Create validated durable attachment records. */
export function attachments(inputs: readonly FactoryAttachmentInput[], now: string, maxCount: number, maxBytes: number): FactoryAttachment[] {
  if (inputs.length > maxCount) throw new Error(`A Factory task accepts at most ${maxCount} attachments`)
  return inputs.map((input) => {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(input.dataUrl)
    if (match === null || match[1] !== input.mediaType || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(input.mediaType)) {
      throw new Error(`Attachment ${JSON.stringify(input.name)} is not a supported matching image data URL`)
    }
    const payload = match[2]
    if (payload === undefined || Buffer.byteLength(payload, 'base64') > maxBytes) throw new Error(`Attachment ${JSON.stringify(input.name)} exceeds ${maxBytes} bytes`)
    return { id: FactoryAttachmentId(identity('attachment')), name: input.name.slice(0, 160), mediaType: input.mediaType, dataUrl: input.dataUrl, createdAt: now }
  })
}

const MAX_AUTOMATION_DELAY_MINUTES = 10_080
const MINUTE_MS = 60_000

/** Normalize and validate one task automation specification. */
export function taskAutomation(spec: FactoryAutomationSpec, defaultEnabled: boolean, now: string): FactoryTaskAutomation {
  const enabled = spec.enabled ?? defaultEnabled
  if (spec.trigger.kind === 'delay') {
    if (!Number.isInteger(spec.trigger.delayMinutes) || spec.trigger.delayMinutes < 1 || spec.trigger.delayMinutes > MAX_AUTOMATION_DELAY_MINUTES) {
      throw new Error(`Factory automation delay must be an integer from 1 to ${MAX_AUTOMATION_DELAY_MINUTES} minutes`)
    }
    return { enabled, trigger: { kind: 'delay', delayMinutes: spec.trigger.delayMinutes } }
  }
  if (spec.trigger.kind === 'schedule') {
    const at = Date.parse(spec.trigger.at)
    if (!Number.isFinite(at)) throw new Error('Factory automation schedule must be an ISO timestamp')
    const timestamp = new Date(at).toISOString()
    return { enabled, trigger: { kind: 'schedule', at: timestamp }, nextRunAt: timestamp }
  }
  if (spec.trigger.kind === 'recurring') {
    const schedule = normalizeFactoryRecurringSchedule(spec.trigger.schedule)
    return { enabled, trigger: { kind: 'recurring', schedule }, ...(enabled ? { nextRunAt: nextFactoryRecurringRun(schedule, new Date(now)) } : {}) }
  }
  return { enabled, trigger: { kind: 'manual' } }
}

/** Queue due task automations and advance recurring schedules without overlap. */
export function activateTaskAutomations(document: FactoryDocument, now: string): { changed: boolean; activated: FactoryTask[] } {
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) throw new Error('Factory automation activation time must be an ISO timestamp')
  const tasks = new Map(document.tasks.map(task => [task.id, task]))
  const activated: FactoryTask[] = []
  let changed = false
  for (const task of document.tasks) {
    const automation = task.automation
    if (automation === undefined || !automation.enabled || automation.trigger.kind === 'manual') continue
    const recurring = automation.trigger.kind === 'recurring'
    if (recurring ? task.status !== 'scheduled' : task.status !== 'draft') continue
    let nextRunAt: string
    if (automation.trigger.kind === 'schedule') {
      nextRunAt = automation.nextRunAt ?? automation.trigger.at
    } else if (automation.trigger.kind === 'recurring') {
      nextRunAt = automation.nextRunAt ?? nextFactoryRecurringRun(automation.trigger.schedule, new Date(task.updatedAt))
    } else {
      const dependencies = task.dependencyIds.flatMap(id => tasks.get(id) ?? [])
      if (dependencies.length !== task.dependencyIds.length || dependencies.some(dependency => dependency.status !== 'succeeded')) continue
      const baseMs = dependencies.length === 0
        ? Date.parse(task.updatedAt)
        : Math.max(...dependencies.map(dependency => Date.parse(dependency.updatedAt)))
      nextRunAt = new Date(baseMs + automation.trigger.delayMinutes * MINUTE_MS).toISOString()
    }
    if (automation.nextRunAt !== nextRunAt) { automation.nextRunAt = nextRunAt; changed = true }
    if (Date.parse(nextRunAt) > nowMs) continue
    task.status = 'queued'
    task.updatedAt = now
    if (automation.trigger.kind === 'recurring') automation.nextRunAt = nextFactoryRecurringRun(automation.trigger.schedule, new Date(now))
    else { automation.enabled = false; delete automation.nextRunAt }
    delete task.failure
    delete task.output
    activated.push(task)
    changed = true
  }
  return { changed, activated }
}

/** Add one independent task. */
export function addTask(document: FactoryDocument, input: {
  project: FactoryProject
  title: string
  description: string
  prompt: string
  priority: FactoryPriority
  labels: string[]
  dependencyIds: FactoryTaskId[]
  lane: FactoryTask['lane']
  preset?: string
  model?: string
  automation?: FactoryAutomationSpec
  attachments: FactoryAttachment[]
  enqueue: boolean
  now: string
  flowId?: FactoryFlowId
  intakeSessionId?: string
  intakeId?: FactoryIntakeId
  finalizer?: boolean
  finalizerPolicy?: FactoryTask['finalizerPolicy']
}): FactoryTask {
  const automation = input.automation === undefined ? undefined : taskAutomation(input.automation, input.enqueue, input.now)
  if (input.finalizer !== true && input.finalizerPolicy !== undefined) throw new Error('Factory finalizer policy requires a finalizer task')
  const task: FactoryTask = {
    id: FactoryTaskId(identity('task')), identifier: `FAC-${document.nextTaskNumber++}`, projectId: input.project.id,
    title: input.title.trim(), description: input.description.trim(), prompt: input.prompt.trim(),
    status: automation?.trigger.kind === 'recurring' && automation.enabled ? 'scheduled' : input.enqueue && automation === undefined ? 'queued' : 'draft',
    priority: input.priority, labels: [...new Set(input.labels.map(label => label.trim()).filter(Boolean))], dependencyIds: [...new Set(input.dependencyIds)],
    lane: structuredClone(input.lane), finalizer: input.finalizer ?? false, attachments: structuredClone(input.attachments), comments: [],
    createdAt: input.now, updatedAt: input.now,
    ...(input.preset === undefined || input.preset === '' ? {} : { preset: input.preset }),
    ...(input.model === undefined || input.model === '' ? {} : { model: input.model }),
    ...(automation === undefined ? {} : { automation }),
    ...(input.flowId === undefined ? {} : { flowId: input.flowId }),
    ...(input.intakeSessionId === undefined ? {} : { intakeSessionId: input.intakeSessionId }),
    ...(input.intakeId === undefined ? {} : { intakeId: input.intakeId }),
    ...(input.finalizerPolicy === undefined ? {} : { finalizerPolicy: input.finalizerPolicy }),
  }
  if (task.title.length === 0 || task.prompt.length === 0) throw new Error('Factory task title and prompt are required')
  document.tasks.push(task)
  return task
}

/** Add or reuse one canonical-path project. */
export function ensureProject(document: FactoryDocument, resolved: { path: string; title: string; repositoryId?: string; defaultRef?: string }, now: string): FactoryProject {
  const existing = document.projects.find(project => project.mainPath === resolved.path)
  if (existing !== undefined) {
    existing.title = resolved.title
    existing.updatedAt = now
    if (resolved.repositoryId !== undefined) existing.repositoryId = resolved.repositoryId
    if (resolved.defaultRef !== undefined) existing.defaultRef = resolved.defaultRef
    return existing
  }
  const project: FactoryProject = {
    id: FactoryProjectId(identity('project')), title: resolved.title, mainPath: resolved.path,
    settings: { autoTitle: true, lane: { mode: 'isolated' } }, createdAt: now, updatedAt: now,
    ...(resolved.repositoryId === undefined ? {} : { repositoryId: resolved.repositoryId }),
    ...(resolved.defaultRef === undefined ? {} : { defaultRef: resolved.defaultRef }),
  }
  document.projects.push(project)
  return project
}

/** Append a user-authored task discussion item with optional bounded images. */
export function addComment(task: FactoryTask, body: string, images: readonly FactoryAttachment[], now: string): void {
  if (body.trim().length === 0 && images.length === 0) throw new Error('Factory comment cannot be empty')
  task.comments.push({
    id: FactoryCommentId(identity('comment')), author: 'user', body: body.trim(),
    ...(images.length === 0 ? {} : { attachments: [...images] }), createdAt: now,
  })
  task.updatedAt = now
}

/**
 * Allocate one durable run attempt and mark its task dispatching.
 * @param document - Mutable Factory document receiving the run.
 * @param task - Task bound to the attempt.
 * @param processId - Process that observed or launched the Session.
 * @param origin - Whether scheduler recovery owns disappearance handling.
 * @param now - Shared mutation timestamp.
 * @returns The appended run with its next task-local attempt number.
 */
export function addRun(document: FactoryDocument, task: FactoryTask, processId: FactoryProcessId, origin: FactoryRun['origin'], now: string): FactoryRun {
  const attempt = document.runs.filter(run => run.taskId === task.id).length + 1
  const run: FactoryRun = {
    id: FactoryRunId(identity('run')), taskId: task.id, origin, attempt, status: 'dispatching', processId, startedAt: now, updatedAt: now,
    ...(task.automation?.trigger.kind === 'recurring' ? { schedule: structuredClone(task.automation.trigger.schedule) } : {}),
  }
  document.runs.push(run)
  task.activeRunId = run.id
  task.status = 'dispatching'
  delete task.failure
  if (task.automation?.trigger.kind !== 'recurring') delete task.output
  task.updatedAt = now
  return run
}
