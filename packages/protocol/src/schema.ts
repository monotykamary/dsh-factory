import { z } from 'zod'
import type { FactoryAgentObservation, FactoryDocument } from './types.ts'

const id = z.string().min(1)
const timestamp = z.string().min(1)
const recurringSchedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hourly'), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal('daily'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal('weekdays'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal('weekly'), weekdays: z.array(z.number().int().min(0).max(6)).min(1), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(31), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal('cron'), expression: z.string().min(1).max(256) }),
])
const automationTrigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('delay'), delayMinutes: z.number().int().min(1).max(10_080) }),
  z.object({ kind: z.literal('schedule'), at: z.string().datetime() }),
  z.object({ kind: z.literal('recurring'), schedule: recurringSchedule }),
])
const taskAutomation = z.object({ trigger: automationTrigger, enabled: z.boolean(), nextRunAt: z.string().datetime().optional() })
const lane = z.object({ mode: z.enum(['current', 'isolated', 'reuse']), reuseTaskId: id.optional(), baseRef: z.string().optional() })
const attachment = z.object({ id, name: z.string(), mediaType: z.string(), dataUrl: z.string(), createdAt: timestamp })
const comment = z.object({ id, author: z.enum(['user', 'agent', 'system']), body: z.string(), attachments: z.array(attachment).optional(), createdAt: timestamp })
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const mutationDiff = z.object({ path: z.string().min(1), oldText: z.string().nullable(), newText: z.string() })
const projectSettings = z.object({
  model: z.string().min(1).optional(), titleModel: z.string().min(1).optional(), autoTitle: z.boolean(),
  titlePrompt: z.string().min(1).max(4_000).optional(), descriptionPrompt: z.string().min(1).max(4_000).optional(),
  lane: z.object({ mode: z.enum(['current', 'isolated']), baseRef: z.string().min(1).optional() }),
  setupCommand: z.string().min(1).optional(),
}).strict()
const project = z.object({
  id, title: z.string(), mainPath: z.string(), repositoryId: z.string().optional(), defaultRef: z.string().optional(),
  settings: projectSettings, createdAt: timestamp, updatedAt: timestamp,
}).strict()
const metadataGeneration = z.object({
  id, projectId: id,
  target: z.object({ kind: z.literal('task'), id }),
  status: z.enum(['running', 'succeeded', 'failed']),
  route: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
  system: z.string(), input: z.string(), maxTokens: z.number().int().positive(),
  output: z.string().optional(), error: z.string().optional(), createdAt: timestamp, updatedAt: timestamp,
}).strict()

function mutationLineCount(text: string | null): number {
  if (text === null || text === '') return 0
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length
}
const fileMutation = z.object({
  commitOrder: z.number().int().nonnegative(), path: z.string().min(1), operation: z.enum(['create', 'modify', 'delete']),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
  beforeSha256: sha256.nullable(), afterSha256: sha256.nullable(), diffs: z.array(mutationDiff).min(1),
}).superRefine((value, context) => {
  const invalidHashes = value.operation === 'create'
    ? value.beforeSha256 !== null || value.afterSha256 === null
    : value.operation === 'modify'
      ? value.beforeSha256 === null || value.afterSha256 === null
      : value.beforeSha256 === null || value.afterSha256 !== null
  if (invalidHashes) context.addIssue({ code: 'custom', message: `${value.operation} mutation hashes disagree with the operation` })
  if (value.diffs.some(diff => diff.path !== value.path)) context.addIssue({ code: 'custom', message: 'mutation hunk path disagrees with the mutation path' })
  if (value.operation === 'create' && value.diffs.some(diff => diff.oldText !== null)) context.addIssue({ code: 'custom', message: 'create mutation removes existing text' })
  if (value.operation === 'delete' && value.diffs.some(diff => diff.newText !== '')) context.addIssue({ code: 'custom', message: 'delete mutation retains added text' })
  const additions = value.diffs.reduce((total, diff) => total + mutationLineCount(diff.newText), 0)
  const deletions = value.diffs.reduce((total, diff) => total + mutationLineCount(diff.oldText), 0)
  if (value.additions !== additions || value.deletions !== deletions) context.addIssue({ code: 'custom', message: 'mutation line totals disagree with its hunks' })
})
const output = z.object({
  summary: z.string(), details: z.string().optional(), artifacts: z.array(z.string()), mutations: z.array(fileMutation),
  checkoutPath: z.string().optional(), sessionId: z.string().optional(), completedAt: timestamp,
}).superRefine((value, context) => {
  for (let index = 1; index < value.mutations.length; index += 1) {
    if (value.mutations[index]!.commitOrder <= value.mutations[index - 1]!.commitOrder) {
      context.addIssue({ code: 'custom', message: 'output mutations must use strictly increasing commit order' })
      return
    }
  }
})
const task = z.object({
  id, identifier: z.string(), projectId: id, flowId: id.optional(),
  title: z.string(), description: z.string(), prompt: z.string(),
  status: z.enum(['draft', 'scheduled', 'queued', 'dispatching', 'running', 'waiting', 'paused', 'succeeded', 'failed', 'cancelled']),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  labels: z.array(z.string()), dependencyIds: z.array(id), lane, finalizer: z.boolean(), intakeSessionId: z.string().min(1).optional(),
  finalizerPolicy: z.enum(['success', 'always']).optional(), preset: z.string().optional(), model: z.string().optional(), automation: taskAutomation.optional(),
  attachments: z.array(attachment), comments: z.array(comment), activeRunId: id.optional(), output: output.optional(), failure: z.string().optional(),
  createdAt: timestamp, updatedAt: timestamp,
})
const factoryDocumentSchema = z.object({
  formatVersion: z.literal(0), nextTaskNumber: z.number().int().positive(),
  projects: z.array(project),
  tasks: z.array(task),
  flows: z.array(z.object({ id, projectId: id, kind: z.enum(['standard', 'inbox']), title: z.string(), description: z.string(), taskIds: z.array(id), status: z.enum(['draft', 'scheduled', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled']), createdAt: timestamp, updatedAt: timestamp })),
  runs: z.array(z.object({ id, taskId: id, origin: z.enum(['scheduler', 'observed']), attempt: z.number().int().positive(), status: z.enum(['dispatching', 'running', 'waiting', 'succeeded', 'failed', 'cancelled']), processId: id, sessionId: z.string().optional(), checkoutPath: z.string().optional(), startedAt: timestamp, updatedAt: timestamp, finishedAt: timestamp.optional(), failure: z.string().optional(), schedule: recurringSchedule.optional(), output: output.optional(), reviewedAt: timestamp.optional() })),
  activities: z.array(z.object({ id: z.string(), taskId: id.optional(), flowId: id.optional(), kind: z.string(), message: z.string(), createdAt: timestamp })),
  metadataGenerations: z.array(metadataGeneration).default([]),
})

const agentObservationSchema = z.object({
  processId: id, agentId: z.string(), sessionId: z.string(), status: z.enum(['idle', 'running', 'disposed']),
  taskId: id.optional(), runId: id.optional(), cwd: z.string().optional(), preset: z.string().optional(), provider: z.string().optional(), model: z.string().optional(), title: z.string().optional(),
  origin: z.literal('subagent').optional(), delegationDepth: z.number().int().nonnegative().optional(), heartbeatAt: timestamp,
}).strict()

/** Parse an untrusted cross-process Agent observation. */
export function parseFactoryAgentObservation(input: unknown): FactoryAgentObservation {
  return agentObservationSchema.parse(input) as FactoryAgentObservation
}

/** Parse an untrusted durable document and reject unknown fields or wrong format versions. */
export function parseFactoryDocument(input: unknown): FactoryDocument {
  return factoryDocumentSchema.strict().parse(input) as FactoryDocument
}
