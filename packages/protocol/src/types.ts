import type { Branded } from '@monotykamary/dsh-brand'

/** Opaque identity for one Factory project. */
export type FactoryProjectId = Branded<'FactoryProjectId'>
/** Opaque identity for one Factory task. */
export type FactoryTaskId = Branded<'FactoryTaskId'>
/** Opaque identity for one Factory flow. */
export type FactoryFlowId = Branded<'FactoryFlowId'>
/** Opaque identity for one Factory task execution. */
export type FactoryRunId = Branded<'FactoryRunId'>
/** Opaque identity for one Factory comment. */
export type FactoryCommentId = Branded<'FactoryCommentId'>
/** Opaque identity for one Factory attachment. */
export type FactoryAttachmentId = Branded<'FactoryAttachmentId'>
/** Opaque identity for one reviewable file under a run checkout's `.artifacts` directory. */
export type FactoryArtifactMediaId = Branded<'FactoryArtifactMediaId'>
/** Opaque identity for one process publishing observed Agents. */
export type FactoryProcessId = Branded<'FactoryProcessId'>
/** Opaque identity for one logged Factory metadata-generation request. */
export type FactoryMetadataGenerationId = Branded<'FactoryMetadataGenerationId'>
/** Opaque identity for one New Session composer submission. */
export type FactoryIntakeId = Branded<'FactoryIntakeId'>

/** Durable task lifecycle. */
export type FactoryTaskStatus = 'draft' | 'scheduled' | 'queued' | 'dispatching' | 'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'cancelled'
/** Durable flow role: ordinary user graph or per-project emerging-work sink. */
export type FactoryFlowKind = 'standard' | 'inbox'
/** Flow lifecycle derived from its member tasks. */
export type FactoryFlowStatus = 'draft' | 'scheduled' | 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
/** Linear-compatible priority: none, urgent, high, medium, or low. */
export type FactoryPriority = 0 | 1 | 2 | 3 | 4
/** Friendly recurring schedule compiled to local-time cron by the domain. */
export type FactoryRecurringSchedule =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; weekdays: number[]; hour: number; minute: number }
  | { kind: 'monthly'; dayOfMonth: number; hour: number; minute: number }
  | { kind: 'cron'; expression: string }

/** One automatic queueing condition for a DSH task prompt. */
export type FactoryAutomationTrigger =
  | { kind: 'manual' }
  | { kind: 'delay'; delayMinutes: number }
  | { kind: 'schedule'; at: string }
  | { kind: 'recurring'; schedule: FactoryRecurringSchedule }

/** User-authored automation settings embedded in a task. */
export interface FactoryAutomationSpec {
  trigger: FactoryAutomationTrigger
  enabled?: boolean
}

/** Durable task automation state derived from a user-authored specification. */
export interface FactoryTaskAutomation {
  trigger: FactoryAutomationTrigger
  enabled: boolean
  nextRunAt?: string
}

/** Repository checkout allocation strategy. */
export type FactoryLaneMode = 'current' | 'isolated' | 'reuse'
/** Finalizer eligibility after ordinary flow nodes settle. */
export type FactoryFinalizerPolicy = 'success' | 'always'

/** Default instruction used to generate a task title. */
export const DEFAULT_FACTORY_TITLE_PROMPT = 'Write a concise imperative task title of at most eight words in the prompt language.'
/** Default instruction used to generate a task description. */
export const DEFAULT_FACTORY_DESCRIPTION_PROMPT = 'Write one compact sentence that states the requested outcome and important constraints in the prompt language.'

/** Project-owned defaults inherited by Factory tasks and flows. */
export interface FactoryProjectSettings {
  model?: string
  titleModel?: string
  autoTitle: boolean
  titlePrompt?: string
  descriptionPrompt?: string
  lane: { mode: 'current' | 'isolated'; baseRef?: string }
  setupCommand?: string
}

/** Repository identity and execution defaults shared by tasks. */
export interface FactoryProject {
  id: FactoryProjectId
  title: string
  mainPath: string
  repositoryId?: string
  defaultRef?: string
  settings: FactoryProjectSettings
  createdAt: string
  updatedAt: string
}

/** Browser-supplied task attachment before host identity assignment. */
export interface FactoryAttachmentInput {
  name: string
  mediaType: string
  dataUrl: string
}

/** One bounded browser-supplied task attachment. */
export interface FactoryAttachment {
  id: FactoryAttachmentId
  name: string
  mediaType: string
  dataUrl: string
  createdAt: string
}

/** Immutable task discussion item. */
export interface FactoryComment {
  id: FactoryCommentId
  author: 'user' | 'agent' | 'system'
  body: string
  /** Bounded images pasted with this comment; absent in older documents. */
  attachments?: FactoryAttachment[]
  createdAt: string
}

/** Checkout lane requested by one task. */
export interface FactoryLaneSpec {
  mode: FactoryLaneMode
  reuseTaskId?: FactoryTaskId
  baseRef?: string
}

/** One receipt hunk normalized for durable Factory output and changed-file presentation. */
export interface FactoryMutationDiff {
  path: string
  oldText: string | null
  newText: string
}

/** One receipt-aware file mutation committed during a Factory run. */
export interface FactoryFileMutation {
  commitOrder: number
  path: string
  operation: 'create' | 'modify' | 'delete'
  additions: number
  deletions: number
  beforeSha256: string | null
  afterSha256: string | null
  diffs: FactoryMutationDiff[]
}

/** Scheduler-facing task result. */
export interface FactoryTaskOutput {
  summary: string
  details?: string
  artifacts: string[]
  mutations: FactoryFileMutation[]
  checkoutPath?: string
  sessionId?: string
  completedAt: string
}

/** Browser-reviewable image or video discovered under one run checkout's `.artifacts` directory. */
export interface FactoryArtifactMedia {
  id: FactoryArtifactMediaId
  kind: 'image' | 'video'
  name: string
  /** Slash-separated path relative to `.artifacts`. */
  path: string
  mediaType: string
  bytes: number
  modifiedAt: string
  /** File revision used to reject a read racing a replacement. */
  version: string
}

/** Select the task checkout, or one exact historical run checkout, whose `.artifacts` directory is listed. */
export interface FactoryArtifactMediaRequest {
  taskId: FactoryTaskId
  runId?: FactoryRunId
}

/** Read selected media files from the exact listing revisions returned to the browser. */
export interface FactoryArtifactMediaDataRequest extends FactoryArtifactMediaRequest {
  media: { mediaId: FactoryArtifactMediaId; version: string }[]
}

/** Base64 data URL for one validated `.artifacts` file revision. */
export interface FactoryArtifactMediaData {
  mediaId: FactoryArtifactMediaId
  version: string
  dataUrl: string
}

/** Durable unit of work and dependency-graph node. */
export interface FactoryTask {
  id: FactoryTaskId
  identifier: string
  projectId: FactoryProjectId
  flowId?: FactoryFlowId
  /** Blank Session whose composer created this task without sending a prompt. */
  intakeSessionId?: string
  /** Composer submission identity used to make transport retries idempotent. */
  intakeId?: FactoryIntakeId
  title: string
  description: string
  prompt: string
  status: FactoryTaskStatus
  priority: FactoryPriority
  labels: string[]
  dependencyIds: FactoryTaskId[]
  lane: FactoryLaneSpec
  finalizer: boolean
  finalizerPolicy?: FactoryFinalizerPolicy
  preset?: string
  model?: string
  automation?: FactoryTaskAutomation
  attachments: FactoryAttachment[]
  comments: FactoryComment[]
  activeRunId?: FactoryRunId
  output?: FactoryTaskOutput
  failure?: string
  createdAt: string
  updatedAt: string
}

/** Named collection of tasks instantiated together. */
export interface FactoryFlow {
  id: FactoryFlowId
  projectId: FactoryProjectId
  kind: FactoryFlowKind
  title: string
  description: string
  taskIds: FactoryTaskId[]
  status: FactoryFlowStatus
  createdAt: string
  updatedAt: string
}

/** One scheduler attempt or observed DSH Session binding. */
export interface FactoryRun {
  id: FactoryRunId
  taskId: FactoryTaskId
  /** Scheduler attempts recover on disappearance; observed bindings wait for Session resume. */
  origin: 'scheduler' | 'observed'
  attempt: number
  status: 'dispatching' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  processId: FactoryProcessId
  sessionId?: string
  checkoutPath?: string
  startedAt: string
  updatedAt: string
  finishedAt?: string
  failure?: string
  schedule?: FactoryRecurringSchedule
  output?: FactoryTaskOutput
  reviewedAt?: string
}

/** Auditable state transition shown in the card activity feed. */
export interface FactoryActivity {
  id: string
  taskId?: FactoryTaskId
  flowId?: FactoryFlowId
  kind: string
  message: string
  createdAt: string
}

/** Exact durable receipt for one auxiliary title/description model request. */
export interface FactoryMetadataGeneration {
  id: FactoryMetadataGenerationId
  projectId: FactoryProjectId
  target: { kind: 'task'; id: FactoryTaskId }
  status: 'running' | 'succeeded' | 'failed'
  route: { provider: string; model: string }
  system: string
  input: string
  maxTokens: number
  output?: string
  error?: string
  createdAt: string
  updatedAt: string
}

/** Durable SQLite document updated under compare-and-set transactions. */
export interface FactoryDocument {
  formatVersion: 0
  nextTaskNumber: number
  projects: FactoryProject[]
  tasks: FactoryTask[]
  flows: FactoryFlow[]
  runs: FactoryRun[]
  activities: FactoryActivity[]
  metadataGenerations: FactoryMetadataGeneration[]
}

/** Ephemeral projection of any live DSH Agent, whether assigned or not yet tracked. */
export interface FactoryAgentObservation {
  processId: FactoryProcessId
  agentId: string
  sessionId: string
  status: 'idle' | 'running' | 'disposed'
  taskId?: FactoryTaskId
  runId?: FactoryRunId
  cwd?: string
  preset?: string
  provider?: string
  model?: string
  title?: string
  origin?: 'subagent'
  delegationDepth?: number
  heartbeatAt: string
}

/** Ephemeral scheduler-leader state. */
export interface FactoryLeaderObservation {
  processId: FactoryProcessId
  expiresAt: string
}

/** Complete Remote projection; `revision` is the next mutation precondition. */
export interface FactorySnapshot {
  revision: number
  document: FactoryDocument
  agents: FactoryAgentObservation[]
  defaultModel: string
  leader?: FactoryLeaderObservation
  generatedAt: string
}

/** Common optimistic-concurrency field accepted by mutations. */
export interface FactoryMutationRequest {
  expectedRevision?: number
}

/** Create one independent task in a local project. */
export interface FactoryCreateTaskRequest extends FactoryMutationRequest {
  projectPath: string
  projectTitle?: string
  title?: string
  description?: string
  prompt: string
  priority?: FactoryPriority
  labels?: string[]
  dependencyIds?: FactoryTaskId[]
  lane?: FactoryLaneSpec
  preset?: string
  model?: string
  attachments?: FactoryAttachmentInput[]
  automation?: FactoryAutomationSpec
  finalizer?: boolean
  finalizerPolicy?: FactoryFinalizerPolicy
  enqueue?: boolean
}

/** Placement of a New Session task within an existing flow. */
export type FactoryFlowIntakePlacement = 'parallel' | 'sequential' | 'finalizer'

/** Create draft Factory work from the current blank DSH Session composer without prompting it. */
export interface FactorySessionIntakeRequest extends FactoryMutationRequest {
  sessionId: string
  intakeId: FactoryIntakeId
  prompt: string
  destination: 'task' | 'new-flow' | 'flow'
  /** Required only for an existing-flow destination. */
  flowId?: FactoryFlowId
  /** Required only for an existing-flow destination. */
  placement?: FactoryFlowIntakePlacement
  attachments?: FactoryAttachmentInput[]
}

/** Task identity and snapshot committed by one New Session intake. */
export interface FactorySessionIntakeResult {
  taskId: FactoryTaskId
  snapshot: FactorySnapshot
}

/** Replace the project defaults inherited by future and unresolved work. */
export interface FactoryUpdateProjectRequest extends FactoryMutationRequest {
  projectPath: string
  projectTitle?: string
  settings: FactoryProjectSettings
}

/** Place observed live Sessions in workspace inbox flows or one named waiting flow. */
export interface FactoryAdoptSessionsRequest extends FactoryMutationRequest {
  sessionIds: string[]
  /** Omission places each Session in its workspace's emerging-work sink. */
  flowTitle?: string
}

/** Move connected sink tasks into one named ordinary flow. */
export interface FactoryGroupTasksRequest extends FactoryMutationRequest {
  taskIds: FactoryTaskId[]
  title: string
}

/** Editable task fields; omitted values remain unchanged. */
export interface FactoryUpdateTaskRequest extends FactoryMutationRequest {
  taskId: FactoryTaskId
  title?: string
  description?: string
  prompt?: string
  priority?: FactoryPriority
  labels?: string[]
  dependencyIds?: FactoryTaskId[]
  lane?: FactoryLaneSpec
  preset?: string
  /** Routing-only field: may change while a run is active and takes effect on the next model step of a Live run. */
  model?: string
  automation?: FactoryAutomationSpec | null
}

/** One text and/or image discussion append. */
export interface FactoryCommentRequest extends FactoryMutationRequest {
  taskId: FactoryTaskId
  body: string
  attachments?: FactoryAttachmentInput[]
}

/** Add one dependency edge from `taskId` to `dependsOnTaskId`. */
export interface FactoryConnectRequest extends FactoryMutationRequest {
  taskId: FactoryTaskId
  dependsOnTaskId: FactoryTaskId
}

/** Start every draft node in one grouped flow while preserving timed stages. */
export interface FactoryFlowActionRequest extends FactoryMutationRequest {
  flowId: FactoryFlowId
}

/** Task identity plus optional optimistic revision for one lifecycle mutation. */
export interface FactoryTaskActionRequest extends FactoryMutationRequest {
  taskId: FactoryTaskId
}

/** Mark selected terminal-run results reviewed in Triage. */
export interface FactoryReviewRunsRequest extends FactoryMutationRequest {
  runIds: FactoryRunId[]
}

/** Associate an observed emerging Session with an existing task. */
export interface FactoryAttachSessionRequest extends FactoryMutationRequest {
  taskId: FactoryTaskId
  sessionId: string
}

/** Explicit model report consumed only after the Agent turn settles. */
export interface FactoryFinishReport {
  outcome: 'succeeded' | 'failed' | 'blocked'
  summary: string
  details?: string
  artifacts?: string[]
}

/** Scheduler-owned settlement enriched from the completed Session log. */
export interface FactoryRunSettlement extends FactoryFinishReport {
  mutations: FactoryFileMutation[]
}

/** A dependency-graph validation failure with a stable machine code. */
export interface FactoryGraphIssue {
  code: 'missing-dependency' | 'self-dependency' | 'cycle' | 'cross-project' | 'finalizer-dependency' | 'duplicate-inbox' | 'flow-membership'
  message: string
  taskId?: FactoryTaskId
}

/** Generate a branded project identity. */
export const FactoryProjectId = (value: string): FactoryProjectId => value as FactoryProjectId
/** Generate a branded task identity. */
export const FactoryTaskId = (value: string): FactoryTaskId => value as FactoryTaskId
/** Generate a branded flow identity. */
export const FactoryFlowId = (value: string): FactoryFlowId => value as FactoryFlowId
/** Generate a branded run identity. */
export const FactoryRunId = (value: string): FactoryRunId => value as FactoryRunId
/** Generate a branded comment identity. */
export const FactoryCommentId = (value: string): FactoryCommentId => value as FactoryCommentId
/** Generate a branded attachment identity. */
export const FactoryAttachmentId = (value: string): FactoryAttachmentId => value as FactoryAttachmentId
/** Generate a branded artifact-media identity. */
export const FactoryArtifactMediaId = (value: string): FactoryArtifactMediaId => value as FactoryArtifactMediaId
/** Generate a branded process identity. */
export const FactoryProcessId = (value: string): FactoryProcessId => value as FactoryProcessId
/** Generate a branded metadata-generation identity. */
export const FactoryMetadataGenerationId = (value: string): FactoryMetadataGenerationId => value as FactoryMetadataGenerationId
/** Generate a branded New Session intake identity. */
export const FactoryIntakeId = (value: string): FactoryIntakeId => value as FactoryIntakeId
