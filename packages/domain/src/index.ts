import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { Agent } from '@monotykamary/dsh-agent'
import type { Context } from '@monotykamary/cordis'
import type {} from '@monotykamary/dsh-agent-default-model'
import type {} from '@monotykamary/dsh-llm'
import type {} from '@monotykamary/dsh-session-title'
import type {} from '@monotykamary/dsh-worktree'
import { Remote, TypertRemoteService } from '@monotykamary/dsh-typert-protocol'
import z from '@monotykamary/schemastery'
import { FactoryArtifactMediaId, FactoryFlowId, FactoryMetadataGenerationId, FactoryProcessId, readyTasks } from 'dsh-factory-protocol'
import type {
  FactoryAdoptSessionsRequest, FactoryAgentObservation, FactoryArtifactMedia, FactoryArtifactMediaData, FactoryArtifactMediaDataRequest, FactoryArtifactMediaRequest, FactoryAttachSessionRequest, FactoryCommentRequest, FactoryConnectRequest,
  FactoryCreateTaskRequest, FactoryDocument, FactoryFlow, FactoryFlowActionRequest, FactoryGroupTasksRequest, FactoryMetadataGeneration,
  FactoryMutationRequest, FactoryProject, FactoryProjectSettings, FactoryReviewRunsRequest, FactoryRun, FactoryRunId, FactoryRunSettlement,
  FactorySessionIntakeRequest, FactorySessionIntakeResult, FactorySnapshot, FactoryTask, FactoryTaskActionRequest, FactoryTaskId,
  FactoryUpdateProjectRequest, FactoryUpdateTaskRequest,
} from 'dsh-factory-protocol/types'
import { FACTORY_STORE_NO_CHANGE, type FactoryStoreRead } from 'dsh-factory-store'
import {
  activateTaskAutomations, activity, addComment, addRun, addTask, attachments, deriveFlows,
  ensureProject, expectProject, expectTask, identity, taskAutomation,
} from './mutations.ts'
import {
  boundFactoryMetadataText, factoryMetadataRequest, fallbackFactoryMetadata, generateFactoryMetadata,
  type FactoryMetadataLimits, type FactoryMetadataRequest,
} from './metadata.ts'

export type * from 'dsh-factory-protocol'

/** Cordis plugin and Remote namespace. */
export const name = 'factory'

/** Factory domain policy. */
export interface Config {
  /** Maximum durable activity entries. */
  activityLimit?: number
  /** Agent presence expiry horizon. */
  presenceTtlMs?: number
  /** Agent presence heartbeat interval. */
  heartbeatMs?: number
  /** Maximum attachments per task. */
  attachmentLimit?: number
  /** Maximum decoded bytes per attachment. */
  attachmentBytes?: number
  /** Whether projects default to generated task and flow metadata. */
  titleGenerationEnabled?: boolean
  /** Maximum retained metadata-generation receipts. */
  metadataGenerationLimit?: number
  /** Maximum UTF-8 bytes in one title-generation input. */
  titleMaxInputBytes?: number
  /** Maximum output tokens for one title-generation request. */
  titleMaxOutputTokens?: number
  /** Metadata-generation timeout. */
  titleTimeoutMs?: number
  /** Maximum UTF-8 bytes in a generated title. */
  titleMaxBytes?: number
  /** Maximum UTF-8 bytes in a generated description. */
  descriptionMaxBytes?: number
  /** Maximum image/video files returned from one `.artifacts` directory. */
  artifactMediaLimit?: number
  /** Maximum bytes in one reviewable artifact media file. */
  artifactMediaBytes?: number
  /** Maximum aggregate bytes represented by one artifact-media listing. */
  artifactMediaTotalBytes?: number
  /** Maximum nested directory depth scanned below `.artifacts`. */
  artifactMediaDepth?: number
}

interface ResolvedConfig {
  activityLimit: number
  presenceTtlMs: number
  heartbeatMs: number
  attachmentLimit: number
  attachmentBytes: number
  titleGenerationEnabled: boolean
  metadataGenerationLimit: number
  titleMaxOutputTokens: number
  metadataLimits: FactoryMetadataLimits
  artifactMediaLimit: number
  artifactMediaBytes: number
  artifactMediaTotalBytes: number
  artifactMediaDepth: number
}

interface ResolvedProject {
  path: string
  title: string
  repositoryId?: string
  defaultRef?: string
}

/** A task atomically reserved by the elected scheduler. */
export interface FactoryTaskClaim {
  task: FactoryTask
  project: FactoryProject
  run: FactoryRun
}

const iso = (): string => new Date().toISOString()
const expiry = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString()
const olderThan = (milliseconds: number): string => new Date(Date.now() - milliseconds).toISOString()
const EMERGING_WORK_TITLE = 'Emerging work'
const EMERGING_WORK_DESCRIPTION = 'Live Sessions and task-intake work not yet organized into a named flow.'

const ARTIFACT_MEDIA_TYPES = new Map<string, { kind: FactoryArtifactMedia['kind']; mediaType: string }>([
  ['.avif', { kind: 'image', mediaType: 'image/avif' }],
  ['.gif', { kind: 'image', mediaType: 'image/gif' }],
  ['.jpeg', { kind: 'image', mediaType: 'image/jpeg' }],
  ['.jpg', { kind: 'image', mediaType: 'image/jpeg' }],
  ['.png', { kind: 'image', mediaType: 'image/png' }],
  ['.webp', { kind: 'image', mediaType: 'image/webp' }],
  ['.m4v', { kind: 'video', mediaType: 'video/x-m4v' }],
  ['.mov', { kind: 'video', mediaType: 'video/quicktime' }],
  ['.mp4', { kind: 'video', mediaType: 'video/mp4' }],
  ['.ogv', { kind: 'video', mediaType: 'video/ogg' }],
  ['.webm', { kind: 'video', mediaType: 'video/webm' }],
])

interface ScannedArtifactMedia extends FactoryArtifactMedia {
  absolutePath: string
}

function missingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function containedPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/** Typert Remote service and authoritative Factory state machine. */
export class FactoryDomain extends TypertRemoteService {
  static inject = ['factoryStore', 'agents', 'agentDefaultModel', 'llm', 'sessionTitle', 'worktrees']
  static Config: z<Config> = z.object({
    activityLimit: z.number().step(1).min(10).default(500),
    presenceTtlMs: z.number().step(1).min(1_000).default(15_000),
    heartbeatMs: z.number().step(1).min(250).default(3_000),
    attachmentLimit: z.number().step(1).min(0).default(8),
    attachmentBytes: z.number().step(1).min(1_024).default(4_000_000),
    titleGenerationEnabled: z.boolean().default(true),
    metadataGenerationLimit: z.number().step(1).min(10).default(500),
    titleMaxInputBytes: z.number().step(1).min(1_024).default(16_000),
    titleMaxOutputTokens: z.number().step(1).min(16).default(160),
    titleTimeoutMs: z.number().step(1).min(1_000).default(30_000),
    titleMaxBytes: z.number().step(1).min(16).default(160),
    descriptionMaxBytes: z.number().step(1).min(32).default(800),
    artifactMediaLimit: z.number().step(1).min(1).default(100),
    artifactMediaBytes: z.number().step(1).min(1_024).default(50_000_000),
    artifactMediaTotalBytes: z.number().step(1).min(1_024).default(200_000_000),
    artifactMediaDepth: z.number().step(1).min(0).default(4),
  })

  /** Identity used for presence ownership and scheduler lease claims. */
  private readonly processId: FactoryProcessId = FactoryProcessId(identity('process'))
  private readonly config: ResolvedConfig
  private publishing: Promise<void> | undefined
  private publishAgain = false

  /**
   * Register Factory Remote methods and live-Agent presence projection.
   * @param ctx - Cordis context with store, Agent registry, and Worktree capability.
   * @param config - Bounded durable and presence policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'factory')
    this.config = {
      activityLimit: config.activityLimit ?? 500,
      presenceTtlMs: config.presenceTtlMs ?? 15_000,
      heartbeatMs: config.heartbeatMs ?? 3_000,
      attachmentLimit: config.attachmentLimit ?? 8,
      attachmentBytes: config.attachmentBytes ?? 4_000_000,
      titleGenerationEnabled: config.titleGenerationEnabled ?? true,
      metadataGenerationLimit: config.metadataGenerationLimit ?? 500,
      titleMaxOutputTokens: config.titleMaxOutputTokens ?? 160,
      metadataLimits: {
        maxInputBytes: config.titleMaxInputBytes ?? 16_000,
        timeoutMs: config.titleTimeoutMs ?? 30_000,
        maxTitleBytes: config.titleMaxBytes ?? 160,
        maxDescriptionBytes: config.descriptionMaxBytes ?? 800,
      },
      artifactMediaLimit: config.artifactMediaLimit ?? 100,
      artifactMediaBytes: config.artifactMediaBytes ?? 50_000_000,
      artifactMediaTotalBytes: config.artifactMediaTotalBytes ?? 200_000_000,
      artifactMediaDepth: config.artifactMediaDepth ?? 4,
    }
    const schedule = (): void => { void this.schedulePresence() }
    ctx.on('agent/created', schedule, { global: true })
    ctx.on('agent/status', schedule, { global: true })
    ctx.on('agent/disposed', schedule, { global: true })
    ctx.on('session/event', (_session, event) => { if (event.type === 'session/title') schedule() }, { global: true })
    ctx.on('factory-store/committed', schedule, { global: true })
    const timer = setInterval(schedule, this.config.heartbeatMs)
    timer.unref()
    ctx.effect(() => async () => {
      clearInterval(timer)
      await this.publishing
      await ctx.factoryStore.replaceAgentObservations(this.processId, [])
    }, 'factory: Agent presence publisher')
    schedule()
  }

  /** Read the complete durable and live Factory projection. @returns current revisioned snapshot. */
  @Remote
  async snapshot(): Promise<FactorySnapshot> {
    const [stored, agents, leader] = await Promise.all([
      this.ctx.factoryStore.read(),
      this.ctx.factoryStore.readAgentObservations(olderThan(this.config.presenceTtlMs)),
      this.ctx.factoryStore.readLeader(iso()),
    ])
    const projectedAgents = this.projectAgentAssignments(stored.document, agents)
    return {
      revision: stored.revision, document: stored.document, agents: projectedAgents, defaultModel: this.defaultModel(), generatedAt: iso(),
      ...(leader === undefined ? {} : { leader }),
    }
  }

  /** List bounded image/video metadata from the selected run checkout's `.artifacts` directory. @param request - task and optional exact run. @returns deterministic media metadata. */
  @Remote
  async artifactMedia(request: FactoryArtifactMediaRequest): Promise<FactoryArtifactMedia[]> {
    const items = await this.scanArtifactMedia(request)
    return items.map(({ absolutePath: _absolutePath, ...item }) => item)
  }

  /** Read selected listed artifact-media revisions after repeating checkout containment checks. @param request - task/run plus opaque media ids and listed versions. @returns browser data URLs. */
  @Remote
  async artifactMediaData(request: FactoryArtifactMediaDataRequest): Promise<FactoryArtifactMediaData[]> {
    const listed = await this.scanArtifactMedia(request)
    const unique = new Set(request.media.map(item => item.mediaId))
    if (unique.size !== request.media.length) throw new Error('Factory artifact media read contains duplicate ids')
    return Promise.all(request.media.map(async (requested) => {
      const item = listed.find(candidate => candidate.id === requested.mediaId)
      if (item === undefined) throw new Error(`Factory artifact media ${requested.mediaId} does not exist`)
      if (item.version !== requested.version) throw new Error(`Factory artifact media ${requested.mediaId} changed after listing`)
      const before = await stat(item.absolutePath)
      if (`${String(before.size)}:${String(before.mtimeMs)}` !== requested.version) throw new Error(`Factory artifact media ${requested.mediaId} changed before reading`)
      const data = await readFile(item.absolutePath)
      const after = await stat(item.absolutePath)
      if (`${String(after.size)}:${String(after.mtimeMs)}` !== requested.version || data.byteLength !== item.bytes) {
        throw new Error(`Factory artifact media ${requested.mediaId} changed while reading`)
      }
      return { mediaId: item.id, version: item.version, dataUrl: `data:${item.mediaType};base64,${data.toString('base64')}` }
    }))
  }

  /** Create one task after canonical project resolution. @param request - Task fields and project path. @returns committed snapshot. */
  @Remote
  async createTask(request: FactoryCreateTaskRequest): Promise<FactorySnapshot> {
    const resolved = await this.resolveProject(request.projectPath, request.projectTitle)
    const fallback = fallbackFactoryMetadata(request.prompt, this.config.metadataLimits)
    const explicitTitle = request.title?.trim() || undefined
    const explicitDescription = request.description?.trim() || undefined
    let generation: FactoryMetadataGeneration | undefined
    let titleRequest: FactoryMetadataRequest | undefined
    const initial = await this.commit(request, (document, now) => {
      const project = ensureProject(document, resolved, now)
      const task = addTask(document, {
        project, title: explicitTitle ?? fallback.title, description: explicitDescription ?? fallback.description, prompt: request.prompt,
        priority: request.priority ?? 3, labels: request.labels ?? [], dependencyIds: request.dependencyIds ?? [],
        lane: request.lane ?? this.projectLane(project), attachments: attachments(request.attachments ?? [], now, this.config.attachmentLimit, this.config.attachmentBytes),
        enqueue: request.enqueue ?? false, now,
        ...(request.preset === undefined ? {} : { preset: request.preset }), ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.automation === undefined ? {} : { automation: request.automation }),
        ...(request.finalizer === undefined ? {} : { finalizer: request.finalizer }),
        ...(request.finalizerPolicy === undefined ? {} : { finalizerPolicy: request.finalizerPolicy }),
      })
      if (this.shouldGenerateMetadata(project.settings, explicitTitle, explicitDescription)) {
        titleRequest = factoryMetadataRequest(request.prompt, this.metadataRoute(project), this.config.titleMaxOutputTokens, {
          ...(project.settings.titlePrompt === undefined ? {} : { title: project.settings.titlePrompt }),
          ...(project.settings.descriptionPrompt === undefined ? {} : { description: project.settings.descriptionPrompt }),
        })
        generation = this.appendMetadataGeneration(document, project.id, { kind: 'task', id: task.id }, titleRequest, now)
      }
      activity(document, this.config.activityLimit, `${task.identifier} created`, 'task-created', now, task)
    })
    if (generation === undefined || titleRequest === undefined) return initial
    return this.completeMetadataGeneration(generation, titleRequest, fallback, {
      replaceTitle: explicitTitle === undefined,
      replaceDescription: explicitDescription === undefined,
    })
  }

  /**
   * Create draft Factory work from the current blank Session composer.
   * @param request - blank Session identity, prompt, attachments, and task/flow destination.
   * @returns the exact task identity plus the initial committed snapshot.
   */
  @Remote
  async intakeSession(request: FactorySessionIntakeRequest): Promise<FactorySessionIntakeResult> {
    const prompt = request.prompt.trim()
    if (prompt === '') throw new Error('Factory Session intake requires a prompt')
    if (request.destination === 'flow') {
      if (request.flowId === undefined || request.placement === undefined) {
        throw new Error('Factory existing-flow intake requires a flow and placement')
      }
    } else if (request.flowId !== undefined || request.placement !== undefined) {
      throw new Error('Factory flow and placement are valid only for existing-flow intake')
    }
    const agent = this.ctx.agents.list().find(candidate => candidate.id === request.sessionId)
    if (agent === undefined) throw new Error(`Factory cannot intake unavailable Session ${request.sessionId}`)
    if (agent.status !== 'idle' || agent.session.events.some(event => event.type === 'user/message')) {
      throw new Error(`Factory intake requires a blank idle Session: ${request.sessionId}`)
    }
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new Error(`Session ${request.sessionId} has no workspace`)
    const resolved = await this.resolveProject(cwd, undefined)
    const fallback = fallbackFactoryMetadata(prompt, this.config.metadataLimits)
    let generation: FactoryMetadataGeneration | undefined
    let titleRequest: FactoryMetadataRequest | undefined
    let taskId: FactoryTaskId | undefined
    let mirroredFlowId: FactoryFlow['id'] | undefined
    let firstIntake = false
    let refreshMetadata = false
    const initial = await this.commit(request, (document, now) => {
      const project = ensureProject(document, resolved, now)
      let task = document.tasks.find(candidate => candidate.intakeSessionId === request.sessionId)
      if (task === undefined) {
        if (document.runs.some(run => run.sessionId === request.sessionId && ['dispatching', 'running', 'waiting'].includes(run.status))) {
          throw new Error(`Session ${request.sessionId} already belongs to Factory work`)
        }
        task = addTask(document, {
          project, title: fallback.title, description: fallback.description, prompt,
          priority: 3, labels: [], dependencyIds: [], lane: this.projectLane(project),
          attachments: attachments(request.attachments ?? [], now, this.config.attachmentLimit, this.config.attachmentBytes),
          enqueue: false, now, intakeSessionId: request.sessionId,
          ...(agent.session.header.agentPreset === undefined ? {} : { preset: agent.session.header.agentPreset }),
          ...(agent.options.provider === undefined || agent.options.model === undefined ? {} : { model: `${agent.options.provider}:${agent.options.model}` }),
        })
        firstIntake = true
        refreshMetadata = true
      } else {
        if (task.activeRunId !== undefined) throw new Error(`Factory intake task ${task.identifier} is already active`)
        refreshMetadata = task.prompt !== prompt
      }

      task.intakeSessionId = request.sessionId
      task.prompt = prompt
      if (firstIntake || refreshMetadata) {
        task.title = fallback.title
        task.description = fallback.description
      }
      task.status = 'draft'
      task.priority = 3
      task.labels = []
      task.lane = this.projectLane(project)
      task.attachments = attachments(request.attachments ?? [], now, this.config.attachmentLimit, this.config.attachmentBytes)
      task.updatedAt = now
      delete task.failure
      delete task.output
      delete task.automation
      if (agent.session.header.agentPreset === undefined) delete task.preset
      else task.preset = agent.session.header.agentPreset
      if (agent.options.provider === undefined || agent.options.model === undefined) delete task.model
      else task.model = `${agent.options.provider}:${agent.options.model}`

      const source = task.flowId === undefined ? undefined : document.flows.find(flow => flow.id === task.flowId)
      let destination: FactoryFlow
      if (request.destination === 'task') {
        destination = source?.kind === 'standard' ? source : this.ensureInboxFlow(document, project, now)
      } else if (request.destination === 'new-flow') {
        if (source?.kind === 'standard') {
          destination = source
        } else {
          destination = {
            id: FactoryFlowId(identity('flow')), projectId: project.id, kind: 'standard',
            title: fallback.title, description: fallback.description, taskIds: [], status: 'draft', createdAt: now, updatedAt: now,
          }
          document.flows.push(destination)
          mirroredFlowId = destination.id
        }
      } else {
        const requested = document.flows.find(flow => flow.id === request.flowId)
        if (requested === undefined || requested.kind !== 'standard') throw new Error(`Factory flow ${request.flowId} does not exist`)
        if (requested.projectId !== project.id) throw new Error('Factory Session and flow must share one workspace')
        if (['succeeded', 'failed', 'cancelled'].includes(requested.status)) throw new Error(`Factory flow ${requested.title} is terminal`)
        if (source?.kind === 'standard' && source.id !== requested.id) throw new Error(`Session ${request.sessionId} already belongs to another flow`)
        destination = requested
      }

      if (source?.id !== destination.id) {
        if (source !== undefined) {
          source.taskIds = source.taskIds.filter(id => id !== task.id)
          source.updatedAt = now
        }
        if (!destination.taskIds.includes(task.id)) destination.taskIds.push(task.id)
        task.flowId = destination.id
      } else if (!destination.taskIds.includes(task.id)) {
        destination.taskIds.push(task.id)
      }

      if (request.destination === 'flow') {
        const memberTasks = destination.taskIds
          .filter(id => id !== task.id)
          .flatMap(id => document.tasks.find(candidate => candidate.id === id) ?? [])
        const ordinaryTasks = memberTasks.filter(candidate => !candidate.finalizer)
        const dependedOn = new Set(ordinaryTasks.flatMap(candidate => candidate.dependencyIds))
        const leaves = ordinaryTasks.filter(candidate => !dependedOn.has(candidate.id)).map(candidate => candidate.id)
        task.dependencyIds = request.placement === 'parallel' ? [] : leaves
        task.finalizer = request.placement === 'finalizer'
        if (task.finalizer) task.finalizerPolicy = 'always'
        else {
          delete task.finalizerPolicy
          for (const finalizer of memberTasks.filter(candidate => candidate.finalizer)) {
            if (finalizer.activeRunId !== undefined) throw new Error(`Factory finalizer ${finalizer.identifier} is already active`)
            finalizer.dependencyIds = [...new Set([...finalizer.dependencyIds, task.id])]
            finalizer.updatedAt = now
          }
        }
      } else {
        task.dependencyIds = []
        task.finalizer = false
        delete task.finalizerPolicy
      }

      taskId = task.id
      if (refreshMetadata && this.shouldGenerateMetadata(project.settings, undefined, undefined)) {
        titleRequest = factoryMetadataRequest(prompt, this.metadataRoute(project), this.config.titleMaxOutputTokens, {
          ...(project.settings.titlePrompt === undefined ? {} : { title: project.settings.titlePrompt }),
          ...(project.settings.descriptionPrompt === undefined ? {} : { description: project.settings.descriptionPrompt }),
        })
        generation = this.appendMetadataGeneration(document, project.id, { kind: 'task', id: task.id }, titleRequest, now)
      }
      deriveFlows(document, now)
      if (firstIntake) activity(document, this.config.activityLimit, `${task.identifier} created from New Session`, 'session-intake', now, task, destination)
    })

    if (taskId === undefined) throw new Error('Factory Session intake did not create or resolve a task')
    if (generation !== undefined && titleRequest !== undefined) {
      void this.completeMetadataGeneration(generation, titleRequest, fallback, {
        replaceTitle: true, replaceDescription: true,
        ...(mirroredFlowId === undefined ? {} : { mirroredFlowId }),
      }).catch((error: unknown) => {
        this.ctx.logger.warn(`Factory intake metadata settlement failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return { taskId, snapshot: initial }
  }

  /** Replace one workspace's inherited execution and metadata settings. @param request - Canonical project path and complete settings. @returns committed snapshot. */
  @Remote
  async updateProject(request: FactoryUpdateProjectRequest): Promise<FactorySnapshot> {
    const resolved = await this.resolveProject(request.projectPath, request.projectTitle)
    const settings = this.normalizeProjectSettings(request.settings)
    return this.commit(request, (document, now) => {
      const project = ensureProject(document, resolved, now)
      project.settings = settings
      project.updatedAt = now
      activity(document, this.config.activityLimit, `${project.title} settings updated`, 'project-updated', now)
    })
  }

  /** Place live Sessions in their workspace inbox, or adopt them directly into one named flow. @param request - Session ids and optional group title. @returns committed snapshot. */
  @Remote
  async adoptSessions(request: FactoryAdoptSessionsRequest): Promise<FactorySnapshot> {
    const sessionIds = [...new Set(request.sessionIds)]
    if (sessionIds.length === 0) throw new Error('Factory Session adoption requires at least one Session')
    const current = await this.snapshot()
    const observations = sessionIds.map((sessionId) => {
      const observation = current.agents.find(agent => agent.sessionId === sessionId)
      if (observation === undefined) throw new Error(`Factory cannot observe live Session ${sessionId}`)
      if (observation.cwd === undefined) throw new Error(`Session ${sessionId} has no workspace`)
      return observation
    })
    const emergingObservations = observations.filter(observation => observation.taskId === undefined)
    if (emergingObservations.length === 0) return current
    const resolvedProjects = await Promise.all(emergingObservations.map(async observation => ({
      sessionId: observation.sessionId,
      project: await this.resolveProject(observation.cwd as string, undefined),
    })))
    const flowTitle = request.flowTitle?.trim()
    if (flowTitle !== undefined && flowTitle !== '') {
      const [first] = resolvedProjects
      if (first === undefined || resolvedProjects.some(value => value.project.path !== first.project.path)) {
        throw new Error('Factory can group Sessions only when they share one workspace')
      }
    }
    return this.commit(request, (document, now) => {
      const projectBySession = new Map(resolvedProjects.map(value => [value.sessionId, value.project]))
      let namedFlow: FactoryFlow | undefined
      if (flowTitle !== undefined && flowTitle !== '') {
        const resolved = resolvedProjects[0]?.project
        if (resolved === undefined) throw new Error('Factory named Session flow has no project')
        const project = ensureProject(document, resolved, now)
        namedFlow = {
          id: FactoryFlowId(identity('flow')), projectId: project.id, kind: 'standard', title: flowTitle,
          description: `${String(emergingObservations.length)} adopted live Sessions.`, taskIds: [], status: 'waiting', createdAt: now, updatedAt: now,
        }
        document.flows.push(namedFlow)
      }
      for (const observation of emergingObservations) {
        if (document.runs.some(run => run.sessionId === observation.sessionId && ['dispatching', 'running', 'waiting'].includes(run.status))) continue
        const resolved = projectBySession.get(observation.sessionId)
        if (resolved === undefined) throw new Error(`Factory Session ${observation.sessionId} has no resolved project`)
        const project = ensureProject(document, resolved, now)
        const flow = namedFlow ?? this.ensureInboxFlow(document, project, now)
        const title = observation.title?.trim() || `Session ${observation.sessionId.slice(-8)}`
        const task = addTask(document, {
          project, flowId: flow.id, title, description: 'Observed live DSH Session in emerging work.',
          prompt: `Continue and complete the work already in DSH Session ${observation.sessionId}.`,
          priority: 3, labels: ['session'], dependencyIds: [], lane: this.projectLane(project), attachments: [], enqueue: false, now,
          ...(observation.provider === undefined || observation.model === undefined ? {} : { model: `${observation.provider}:${observation.model}` }),
        })
        const run = addRun(document, task, observation.processId, 'observed', now)
        run.status = 'waiting'
        run.sessionId = observation.sessionId
        if (observation.cwd !== undefined) run.checkoutPath = observation.cwd
        task.status = 'waiting'
        task.updatedAt = now
        flow.taskIds.push(task.id)
        activity(document, this.config.activityLimit, `${observation.sessionId} added to ${flow.title} as ${task.identifier}`, 'session-adopted', now, task, flow)
      }
      if (namedFlow !== undefined && namedFlow.taskIds.length === 0) document.flows.splice(document.flows.indexOf(namedFlow), 1)
      deriveFlows(document, now)
    })
  }

  /** Group related inbox or standalone tasks into one ordinary named flow. @param request - Task ids and destination title. @returns committed snapshot. */
  @Remote
  groupTasks(request: FactoryGroupTasksRequest): Promise<FactorySnapshot> {
    const taskIds = [...new Set(request.taskIds)]
    const title = request.title.trim()
    if (taskIds.length === 0) return Promise.reject(new Error('Factory grouping requires at least one task'))
    if (title === '') return Promise.reject(new Error('Factory grouping requires a flow title'))
    return this.commit(request, (document, now) => {
      const tasks = taskIds.map(id => expectTask(document, id))
      const projectId = tasks[0]?.projectId
      if (projectId === undefined || tasks.some(task => task.projectId !== projectId)) throw new Error('Factory can group only tasks from one workspace')
      const source = document.flows.find(flow => flow.kind === 'inbox' && tasks.every(task => task.flowId === flow.id))
      if (source === undefined && tasks.some(task => task.flowId !== undefined)) throw new Error('Factory can group only standalone tasks or tasks from one emerging-work flow')
      const selected = new Set(taskIds)
      if (source !== undefined) {
        const connectedOutside = source.taskIds.some((id) => {
          const task = expectTask(document, id)
          return selected.has(id)
            ? task.dependencyIds.some(dependencyId => source.taskIds.includes(dependencyId) && !selected.has(dependencyId))
            : task.dependencyIds.some(dependencyId => selected.has(dependencyId))
        })
        if (connectedOutside) throw new Error('Factory grouping must include every connected inbox task')
      }
      const flow: FactoryFlow = {
        id: FactoryFlowId(identity('flow')), projectId, kind: 'standard', title,
        description: source === undefined ? `${String(tasks.length)} related tasks.` : `${String(tasks.length)} tasks grouped from emerging work.`,
        taskIds, status: 'draft', createdAt: now, updatedAt: now,
      }
      document.flows.push(flow)
      if (source !== undefined) { source.taskIds = source.taskIds.filter(id => !selected.has(id)); source.updatedAt = now }
      for (const task of tasks) { task.flowId = flow.id; task.updatedAt = now }
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${flow.title} created from ${String(tasks.length)} tasks`, 'flow-grouped', now, undefined, flow)
    })
  }

  /** Start one draft flow atomically without bypassing its timed stages. @param request - Flow identity and revision. @returns committed snapshot. */
  @Remote
  startFlow(request: FactoryFlowActionRequest): Promise<FactorySnapshot> {
    return this.commit(request, (document, now) => {
      const flow = document.flows.find(candidate => candidate.id === request.flowId)
      if (flow === undefined) throw new Error(`Factory flow ${request.flowId} does not exist`)
      if (flow.kind === 'inbox') throw new Error('Emerging work is an intake sink and cannot be started as a flow')
      const members = flow.taskIds.map(id => expectTask(document, id))
      if (members.some(task => task.status !== 'draft')) throw new Error(`${flow.title} cannot start from ${flow.status}`)
      let changed = false
      for (const task of members) {
        let taskChanged = false
        if (task.automation === undefined) {
          task.status = 'queued'
          taskChanged = true
        } else if (!task.automation.enabled) {
          task.automation = taskAutomation({ trigger: task.automation.trigger, enabled: true }, true, now)
          if (task.automation.trigger.kind === 'recurring') task.status = 'scheduled'
          taskChanged = true
        }
        if (taskChanged) {
          changed = true
          delete task.failure
          delete task.output
          task.updatedAt = now
        }
      }
      if (!changed) throw new Error(`${flow.title} has already started`)
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${flow.title} started`, 'flow-started', now, undefined, flow)
    })
  }

  /** Edit mutable task fields. @param request - Task identity and replacement fields. @returns committed snapshot. */
  @Remote
  updateTask(request: FactoryUpdateTaskRequest): Promise<FactorySnapshot> {
    return this.commit(request, (document, now) => {
      const task = expectTask(document, request.taskId)
      const flow = task.flowId === undefined ? undefined : document.flows.find(candidate => candidate.id === task.flowId)
      const changesExecution = [request.title, request.description, request.prompt, request.priority, request.labels, request.lane, request.preset, request.model, request.automation]
        .some(value => value !== undefined)
      if (task.activeRunId !== undefined && (flow?.kind !== 'inbox' || changesExecution)) throw new Error(`${task.identifier} cannot be edited while a run is active`)
      if (flow?.kind === 'inbox' && request.dependencyIds?.some(id => expectTask(document, id).flowId !== flow.id) === true) {
        throw new Error('Emerging-work dependencies must stay in the same sink')
      }
      if (request.title !== undefined) task.title = request.title.trim()
      if (request.description !== undefined) task.description = request.description.trim()
      if (request.prompt !== undefined) task.prompt = request.prompt.trim()
      if (request.priority !== undefined) task.priority = request.priority
      if (request.labels !== undefined) task.labels = [...new Set(request.labels.map(label => label.trim()).filter(Boolean))]
      if (request.dependencyIds !== undefined) task.dependencyIds = [...new Set(request.dependencyIds)]
      if (request.lane !== undefined) task.lane = structuredClone(request.lane)
      if (request.preset !== undefined) this.replaceOptional(task, 'preset', request.preset)
      if (request.model !== undefined) this.replaceOptional(task, 'model', request.model)
      if (request.automation !== undefined) {
        if (request.automation === null) {
          delete task.automation
          if (task.status === 'scheduled') task.status = 'draft'
        } else {
          task.automation = taskAutomation(request.automation, true, now)
          task.status = task.automation.trigger.kind === 'recurring' ? 'scheduled' : 'draft'
          delete task.failure
          delete task.output
        }
      }
      if (task.title.length === 0 || task.prompt.length === 0) throw new Error('Factory task title and prompt are required')
      task.updatedAt = now
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${task.identifier} updated`, 'task-updated', now, task)
    })
  }

  /** Append a task comment. @param request - Task identity plus text and/or bounded images. @returns committed snapshot. */
  @Remote
  comment(request: FactoryCommentRequest): Promise<FactorySnapshot> {
    return this.commit(request, (document, now) => {
      const task = expectTask(document, request.taskId)
      const images = attachments(request.attachments ?? [], now, this.config.attachmentLimit, this.config.attachmentBytes)
      addComment(task, request.body, images, now)
      activity(document, this.config.activityLimit, `Comment added to ${task.identifier}`, 'comment-added', now, task)
    })
  }

  /** Add one dependency edge. @param request - Dependent and prerequisite tasks. @returns committed snapshot. */
  @Remote
  connect(request: FactoryConnectRequest): Promise<FactorySnapshot> {
    return this.commit(request, (document, now) => {
      const task = expectTask(document, request.taskId)
      const flow = task.flowId === undefined ? undefined : document.flows.find(candidate => candidate.id === task.flowId)
      if (task.activeRunId !== undefined && flow?.kind !== 'inbox') throw new Error(`${task.identifier} cannot change dependencies while a run is active`)
      const dependency = expectTask(document, request.dependsOnTaskId)
      if (flow?.kind === 'inbox' && dependency.flowId !== flow.id) throw new Error('Emerging-work dependencies must stay in the same sink')
      if (!task.dependencyIds.includes(request.dependsOnTaskId)) task.dependencyIds.push(request.dependsOnTaskId)
      task.updatedAt = now
      activity(document, this.config.activityLimit, `${task.identifier} dependency updated`, 'task-connected', now, task)
    })
  }

  /** Queue a draft/retry task or resume its live waiting run. @param request - Task identity. @returns committed snapshot. */
  @Remote
  enqueue(request: FactoryTaskActionRequest): Promise<FactorySnapshot> {
    return this.commit(request, (document, now) => {
      const task = expectTask(document, request.taskId)
      if (task.status === 'paused' && task.activeRunId !== undefined) task.status = 'waiting'
      else if (task.status === 'paused' && task.automation?.trigger.kind === 'recurring') {
        task.automation = taskAutomation({ trigger: task.automation.trigger, enabled: true }, true, now)
        task.status = 'scheduled'
      } else if (task.status === 'scheduled') task.status = 'queued'
      else if (['draft', 'paused', 'failed', 'cancelled'].includes(task.status)) {
        task.status = 'queued'
        delete task.failure
        delete task.output
        delete task.activeRunId
      } else if (task.status !== 'queued') throw new Error(`${task.identifier} cannot be queued from ${task.status}`)
      if (task.automation?.enabled === true && task.automation.trigger.kind !== 'recurring') { task.automation.enabled = false; delete task.automation.nextRunAt }
      task.updatedAt = now
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${task.identifier} queued`, 'task-queued', now, task)
    })
  }

  /** Pause queued or waiting work without destroying its Session. @param request - Task identity. @returns committed snapshot. */
  @Remote
  pause(request: FactoryTaskActionRequest): Promise<FactorySnapshot> {
    return this.commit(request, (document, now) => {
      const task = expectTask(document, request.taskId)
      if (!['draft', 'scheduled', 'queued', 'waiting'].includes(task.status)) throw new Error(`${task.identifier} cannot pause from ${task.status}`)
      task.status = 'paused'
      if (task.automation?.trigger.kind === 'recurring') task.automation.enabled = false
      task.updatedAt = now
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${task.identifier} paused`, 'task-paused', now, task)
    })
  }

  /** Cancel a task and any active run record. @param request - Task identity. @returns committed snapshot. */
  @Remote
  cancel(request: FactoryTaskActionRequest): Promise<FactorySnapshot> {
    return this.commit(request, (document, now) => {
      const task = expectTask(document, request.taskId)
      if (task.status === 'succeeded') throw new Error(`${task.identifier} is already complete`)
      task.status = 'cancelled'
      if (task.automation !== undefined) task.automation.enabled = false
      task.updatedAt = now
      if (task.activeRunId !== undefined) {
        const run = document.runs.find(candidate => candidate.id === task.activeRunId)
        if (run !== undefined) { run.status = 'cancelled'; run.updatedAt = now; run.finishedAt = now }
        delete task.activeRunId
      }
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${task.identifier} cancelled`, 'task-cancelled', now, task)
    })
  }

  /** Retry terminal failed or cancelled work. @param request - Task identity. @returns committed snapshot. */
  @Remote
  retry(request: FactoryTaskActionRequest): Promise<FactorySnapshot> {
    return this.commit(request, (document, now) => {
      const task = expectTask(document, request.taskId)
      if (!['failed', 'cancelled'].includes(task.status)) throw new Error(`${task.identifier} cannot retry from ${task.status}`)
      task.status = 'queued'
      task.updatedAt = now
      delete task.activeRunId
      delete task.failure
      delete task.output
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${task.identifier} retried`, 'task-retried', now, task)
    })
  }

  /** Attach one observed emerging Session to a task. @param request - Task and Session identities. @returns committed snapshot. */
  @Remote
  async attachSession(request: FactoryAttachSessionRequest): Promise<FactorySnapshot> {
    const current = await this.snapshot()
    const observation = current.agents.find(agent => agent.sessionId === request.sessionId)
    if (observation === undefined) throw new Error(`Factory cannot observe live Session ${request.sessionId}`)
    if (observation.taskId !== undefined) throw new Error(`Session ${request.sessionId} is already assigned`)
    return this.commit(request, (document, now) => {
      if (document.runs.some(run => run.sessionId === request.sessionId && ['dispatching', 'running', 'waiting'].includes(run.status))) {
        throw new Error(`Session ${request.sessionId} is already assigned`)
      }
      const task = expectTask(document, request.taskId)
      if (!['draft', 'queued', 'paused'].includes(task.status)) throw new Error(`${task.identifier} cannot attach a Session from ${task.status}`)
      const run = addRun(document, task, observation.processId, 'observed', now)
      run.status = 'waiting'
      run.sessionId = request.sessionId
      if (observation.cwd !== undefined) run.checkoutPath = observation.cwd
      task.status = 'waiting'
      task.updatedAt = now
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${request.sessionId} attached to ${task.identifier}`, 'session-attached', now, task)
    })
  }

  /** Mark selected terminal-run results reviewed in Triage. @param request - Terminal run identities. @returns committed snapshot. */
  @Remote
  reviewRuns(request: FactoryReviewRunsRequest): Promise<FactorySnapshot> {
    const runIds = [...new Set(request.runIds)]
    if (runIds.length === 0) return Promise.reject(new Error('Factory Triage review requires at least one run'))
    return this.commit(request, (document, now) => {
      for (const runId of runIds) {
        const run = document.runs.find(candidate => candidate.id === runId)
        if (run === undefined) throw new Error(`Factory run ${runId} does not exist`)
        expectTask(document, run.taskId)
        if (!['succeeded', 'failed', 'cancelled'].includes(run.status)) {
          throw new Error(`Factory run ${runId} is not a terminal Triage result`)
        }
        run.reviewedAt = now
      }
      activity(document, this.config.activityLimit, `${String(runIds.length)} scheduled run${runIds.length === 1 ? '' : 's'} reviewed`, 'runs-reviewed', now)
    })
  }

  /** Acquire or renew this process's scheduler lease. @param ttlMs - Lease duration. @returns whether this process is leader. */
  async acquireSchedulerLease(ttlMs: number): Promise<boolean> {
    const now = iso()
    const leader = await this.ctx.factoryStore.acquireLeader(this.processId, now, expiry(ttlMs))
    return leader.processId === this.processId
  }

  /** Release this process's scheduler lease during orderly teardown. */
  releaseSchedulerLease(): Promise<void> {
    return this.ctx.factoryStore.releaseLeader(this.processId)
  }

  /** Activate due one-shot or recurring automations. @param at - ISO evaluation time; defaults to now. @returns number of tasks queued. */
  async activateDueAutomations(at: string = iso()): Promise<number> {
    let activatedCount = 0
    await this.ctx.factoryStore.mutate(undefined, (document) => {
      const result = activateTaskAutomations(document, at)
      if (!result.changed) return FACTORY_STORE_NO_CHANGE
      activatedCount = result.activated.length
      for (const task of result.activated) activity(document, this.config.activityLimit, `${task.identifier} automation queued`, 'task-automation-queued', at, task)
      deriveFlows(document, at)
    })
    return activatedCount
  }

  /** Atomically reserve ready tasks while the caller still owns the scheduler lease. @param limit - Maximum new claims. @returns claimed task/run/project triples. */
  async claimReadyTasks(limit: number): Promise<FactoryTaskClaim[]> {
    if (limit <= 0) return []
    const claimed: Array<{ taskId: FactoryTaskId; runId: FactoryRunId }> = []
    const now = iso()
    const committed = await this.ctx.factoryStore.mutate(undefined, (document) => {
      const occupied = new Set<string>()
      let activeCount = 0
      for (const run of document.runs) {
        if (!['dispatching', 'running', 'waiting'].includes(run.status)) continue
        activeCount += 1
        const task = document.tasks.find(candidate => candidate.id === run.taskId)
        if (task !== undefined) occupied.add(this.lanePath(document, task, run.checkoutPath))
      }
      const available = Math.max(0, limit - activeCount)
      for (const task of readyTasks(document)) {
        if (claimed.length >= available) break
        const path = this.lanePath(document, task)
        if (occupied.has(path)) continue
        const run = addRun(document, task, this.processId, 'scheduler', now)
        claimed.push({ taskId: task.id, runId: run.id })
        occupied.add(path)
        activity(document, this.config.activityLimit, `${task.identifier} dispatched`, 'task-dispatched', now, task)
      }
      if (claimed.length === 0) return FACTORY_STORE_NO_CHANGE
      deriveFlows(document, now)
    }, { processId: this.processId, now })
    return claimed.map(({ taskId, runId }) => ({
      task: structuredClone(expectTask(committed.document, taskId)),
      project: structuredClone(expectProject(committed.document, expectTask(committed.document, taskId).projectId)),
      run: structuredClone(this.expectRun(committed.document, runId)),
    }))
  }

  /** Bind a claimed run to its created DSH Session and checkout. */
  bindRun(runId: FactoryRunId, sessionId: string, checkoutPath: string): Promise<FactoryStoreRead> {
    return this.ctx.factoryStore.mutate(undefined, (document) => {
      const now = iso()
      const run = this.expectOwnedRun(document, runId)
      const task = expectTask(document, run.taskId)
      if (task.activeRunId !== run.id || !['dispatching', 'waiting'].includes(run.status)) return FACTORY_STORE_NO_CHANGE
      run.status = 'running'; run.sessionId = sessionId; run.checkoutPath = checkoutPath; run.updatedAt = now
      task.status = 'running'; task.updatedAt = now
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${task.identifier} Agent started`, 'run-started', now, task)
    })
  }

  /** Mark an Agent run as waiting while retaining its live Session and lane. */
  markRunWaiting(runId: FactoryRunId, summary?: string): Promise<FactoryStoreRead> {
    return this.ctx.factoryStore.mutate(undefined, (document) => {
      const now = iso()
      const run = this.expectOwnedRun(document, runId)
      const task = expectTask(document, run.taskId)
      if (task.activeRunId !== run.id || !['dispatching', 'running', 'waiting'].includes(run.status)) return FACTORY_STORE_NO_CHANGE
      run.status = 'waiting'; run.updatedAt = now
      task.status = 'waiting'; task.updatedAt = now
      if (summary !== undefined && summary.trim() !== '') task.comments.push({ id: identity('comment') as never, author: 'agent', body: summary.trim(), createdAt: now })
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${task.identifier} waiting for input`, 'run-waiting', now, task)
    })
  }

  /** Commit an explicit model completion report at the owning Agent's completion boundary. */
  finishRun(runId: FactoryRunId, report: FactoryRunSettlement): Promise<FactoryStoreRead> {
    if (report.outcome === 'blocked') return this.markRunWaiting(runId, report.summary)
    const outcome: 'succeeded' | 'failed' = report.outcome
    return this.ctx.factoryStore.mutate(undefined, (document) => {
      const now = iso()
      const run = this.expectOwnedRun(document, runId)
      const task = expectTask(document, run.taskId)
      if (task.activeRunId !== run.id || !['dispatching', 'running', 'waiting'].includes(run.status)) return FACTORY_STORE_NO_CHANGE
      run.status = outcome; run.updatedAt = now; run.finishedAt = now
      const recurring = task.automation?.trigger.kind === 'recurring' && task.automation.enabled
      task.status = recurring ? 'scheduled' : outcome
      task.updatedAt = now
      delete task.activeRunId
      if (outcome === 'succeeded') {
        task.output = {
          summary: report.summary, artifacts: report.artifacts ?? [], mutations: structuredClone(report.mutations), completedAt: now,
          ...(run.checkoutPath === undefined ? {} : { checkoutPath: run.checkoutPath }),
          ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
          ...(report.details === undefined ? {} : { details: report.details }),
        }
        run.output = structuredClone(task.output)
        delete run.failure
        delete task.failure
      } else {
        run.failure = report.details ?? report.summary
        task.failure = run.failure
        if (!recurring) delete task.output
      }
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${task.identifier} ${outcome}`, `run-${outcome}`, now, task)
    })
  }

  /** Fail a run before or during Agent execution. */
  failRun(runId: FactoryRunId, error: unknown): Promise<FactoryStoreRead> {
    const failure = error instanceof Error ? error.message : String(error)
    return this.ctx.factoryStore.mutate(undefined, (document) => {
      const now = iso()
      const run = this.expectOwnedRun(document, runId)
      const task = expectTask(document, run.taskId)
      if (task.activeRunId !== run.id || !['dispatching', 'running', 'waiting'].includes(run.status)) return FACTORY_STORE_NO_CHANGE
      run.status = 'failed'; run.failure = failure; run.updatedAt = now; run.finishedAt = now
      task.status = task.automation?.trigger.kind === 'recurring' && task.automation.enabled ? 'scheduled' : 'failed'; task.failure = failure; task.updatedAt = now
      delete task.activeRunId
      deriveFlows(document, now)
      activity(document, this.config.activityLimit, `${task.identifier} failed: ${failure}`, 'run-failed', now, task)
    })
  }

  /**
   * Requeue active runs whose owning Session is no longer observed after lease takeover.
   * @param liveSessionIds - Cross-process presence snapshot.
   * @param protectedRunIds - Runs this scheduler is currently constructing or monitoring.
   * @param maxAttempts - Attempts after which an orphan becomes terminal failure.
   */
  requeueOrphanedRuns(liveSessionIds: ReadonlySet<string>, protectedRunIds: ReadonlySet<FactoryRunId>, maxAttempts: number): Promise<FactoryStoreRead> {
    const now = iso()
    return this.ctx.factoryStore.mutate(undefined, (document) => {
      let recovered = 0
      for (const run of document.runs) {
        if (run.origin !== 'scheduler' || !['dispatching', 'running', 'waiting'].includes(run.status) || protectedRunIds.has(run.id)) continue
        if (run.sessionId !== undefined && liveSessionIds.has(run.sessionId)) continue
        const task = document.tasks.find(candidate => candidate.id === run.taskId && candidate.activeRunId === run.id)
        if (task === undefined) continue
        run.status = 'failed'; run.failure = 'Owning Factory process or Session disappeared'; run.updatedAt = now; run.finishedAt = now
        delete task.activeRunId
        task.updatedAt = now
        if (task.automation?.trigger.kind === 'recurring' && task.automation.enabled) {
          task.status = 'scheduled'; task.failure = run.failure
        } else if (run.attempt >= maxAttempts) {
          task.status = 'failed'; task.failure = run.failure
        } else {
          task.status = 'queued'; delete task.failure
        }
        activity(document, this.config.activityLimit, `${task.identifier} recovered after its Session disappeared`, 'run-recovered', now, task)
        recovered += 1
      }
      if (recovered === 0) return FACTORY_STORE_NO_CHANGE
      deriveFlows(document, now)
    }, { processId: this.processId, now })
  }

  /**
   * Resolve this process's active observed run after a fresh Agent-presence publication.
   * @param sessionId - live DSH Session that may have been adopted into Emerging work.
   * @returns the owned active observed run, or undefined when Factory owes it no completion.
   */
  async activeObservedRun(sessionId: string): Promise<FactoryRun | undefined> {
    await this.schedulePresence()
    await this.publishing
    const stored = await this.ctx.factoryStore.read()
    const run = stored.document.runs.toReversed().find(candidate =>
      candidate.origin === 'observed'
      && candidate.processId === this.processId
      && candidate.sessionId === sessionId
      && ['dispatching', 'running', 'waiting'].includes(candidate.status))
    if (run === undefined) return undefined
    const task = stored.document.tasks.find(candidate => candidate.id === run.taskId)
    return task?.activeRunId === run.id ? structuredClone(run) : undefined
  }

  /** Return current state for scheduler cancellation reconciliation. */
  readStore(): Promise<FactoryStoreRead> {
    return this.ctx.factoryStore.read()
  }

  private commit(request: FactoryMutationRequest, mutation: (document: FactoryDocument, now: string) => void): Promise<FactorySnapshot> {
    const now = iso()
    return this.ctx.factoryStore.mutate(request.expectedRevision, (document) => mutation(document, now)).then(async (stored) => {
      this.ctx.emit('factory/changed', stored.revision)
      const [agents, leader] = await Promise.all([
        this.ctx.factoryStore.readAgentObservations(olderThan(this.config.presenceTtlMs)),
        this.ctx.factoryStore.readLeader(iso()),
      ])
      return { revision: stored.revision, document: stored.document, agents: this.projectAgentAssignments(stored.document, agents), defaultModel: this.defaultModel(), generatedAt: iso(), ...(leader === undefined ? {} : { leader }) }
    })
  }

  private projectAgentAssignments(document: FactoryDocument, agents: readonly FactoryAgentObservation[]): FactoryAgentObservation[] {
    const assignments = new Map(document.runs.flatMap(run => run.sessionId === undefined || !['dispatching', 'running', 'waiting'].includes(run.status)
      ? []
      : [[run.sessionId, run] as const]))
    return agents.map((agent) => {
      if (agent.taskId !== undefined) return agent
      const run = assignments.get(agent.sessionId)
      return run === undefined ? agent : { ...agent, taskId: run.taskId, runId: run.id }
    })
  }

  private async artifactCheckout(request: FactoryArtifactMediaRequest): Promise<string | undefined> {
    const stored = await this.ctx.factoryStore.read()
    const task = expectTask(stored.document, request.taskId)
    const selected = request.runId === undefined
      ? stored.document.runs.filter(run => run.taskId === task.id).toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
      : stored.document.runs.find(run => run.id === request.runId)
    if (request.runId !== undefined && selected === undefined) throw new Error(`Factory run ${request.runId} does not exist`)
    if (selected !== undefined && selected.taskId !== task.id) throw new Error(`Factory run ${selected.id} does not belong to ${task.identifier}`)
    return selected === undefined ? task.output?.checkoutPath : selected.checkoutPath
  }

  private async scanArtifactMedia(request: FactoryArtifactMediaRequest): Promise<ScannedArtifactMedia[]> {
    const checkout = await this.artifactCheckout(request)
    if (checkout === undefined) return []
    let checkoutRoot: string
    let artifactRoot: string
    try {
      checkoutRoot = await realpath(checkout)
      artifactRoot = await realpath(join(checkoutRoot, '.artifacts'))
    } catch (error) {
      if (missingPath(error)) return []
      throw error
    }
    if (!containedPath(checkoutRoot, artifactRoot)) throw new Error(`Factory artifact directory escapes checkout ${checkoutRoot}`)
    if (!(await stat(artifactRoot)).isDirectory()) throw new Error(`Factory artifact path is not a directory: ${artifactRoot}`)

    const found: ScannedArtifactMedia[] = []
    const queue: { absolutePath: string; path: string; depth: number }[] = [{ absolutePath: artifactRoot, path: '', depth: 0 }]
    let totalBytes = 0
    while (queue.length > 0 && found.length < this.config.artifactMediaLimit) {
      const directory = queue.shift()!
      let entries
      try { entries = (await readdir(directory.absolutePath, { withFileTypes: true })).toSorted((left, right) => left.name.localeCompare(right.name)) }
      catch (error) { if (missingPath(error)) continue; throw error }
      for (const entry of entries) {
        const path = directory.path === '' ? entry.name : `${directory.path}/${entry.name}`
        const unresolved = join(directory.absolutePath, entry.name)
        if (entry.isDirectory()) {
          if (directory.depth < this.config.artifactMediaDepth) queue.push({ absolutePath: unresolved, path, depth: directory.depth + 1 })
          continue
        }
        if (!entry.isFile()) continue
        const media = ARTIFACT_MEDIA_TYPES.get(extname(entry.name).toLowerCase())
        if (media === undefined) continue
        let absolutePath: string
        let metadata
        try { absolutePath = await realpath(unresolved); metadata = await stat(absolutePath) }
        catch (error) { if (missingPath(error)) continue; throw error }
        if (!containedPath(artifactRoot, absolutePath)) throw new Error(`Factory artifact media escapes .artifacts: ${path}`)
        if (!metadata.isFile() || metadata.size <= 0 || metadata.size > this.config.artifactMediaBytes) continue
        if (totalBytes + metadata.size > this.config.artifactMediaTotalBytes) continue
        totalBytes += metadata.size
        found.push({
          id: FactoryArtifactMediaId(path), kind: media.kind, name: entry.name, path, mediaType: media.mediaType,
          bytes: metadata.size, modifiedAt: metadata.mtime.toISOString(),
          version: `${String(metadata.size)}:${String(metadata.mtimeMs)}`, absolutePath,
        })
        if (found.length >= this.config.artifactMediaLimit) break
      }
    }
    return found.toSorted((left, right) => left.path.localeCompare(right.path))
  }

  private async resolveProject(inputPath: string, requestedTitle: string | undefined): Promise<ResolvedProject> {
    const path = await realpath(inputPath)
    if (!(await stat(path)).isDirectory()) throw new Error(`Factory project path is not a directory: ${path}`)
    const repository = await this.ctx.worktrees.locate({ cwd: path })
    if (repository === undefined) return { path, title: requestedTitle?.trim() || basename(path) }
    const checkouts = await this.ctx.worktrees.list({ cwd: path })
    const main = checkouts.find(checkout => checkout.kind === 'main')
    return {
      path: repository.mainPath, title: requestedTitle?.trim() || repository.name, repositoryId: repository.id,
      ...(main?.branch === null || main?.branch === undefined ? {} : { defaultRef: main.branch }),
    }
  }

  private lanePath(document: FactoryDocument, task: FactoryTask, activePath?: string): string {
    if (activePath !== undefined) return `path:${activePath}`
    if (task.lane.mode === 'isolated') return `isolated:${task.id}`
    const project = expectProject(document, task.projectId)
    if (task.lane.mode === 'current') return `path:${project.mainPath}`
    const source = task.lane.reuseTaskId === undefined ? undefined : document.tasks.find(candidate => candidate.id === task.lane.reuseTaskId)
    return `path:${source?.output?.checkoutPath ?? project.mainPath}`
  }

  private expectRun(document: FactoryDocument, id: FactoryRunId): FactoryRun {
    const run = document.runs.find(candidate => candidate.id === id)
    if (run === undefined) throw new Error(`Factory run ${id} does not exist`)
    return run
  }

  private expectOwnedRun(document: FactoryDocument, id: FactoryRunId): FactoryRun {
    const run = this.expectRun(document, id)
    if (run.processId !== this.processId) throw new Error(`Factory run ${id} is owned by another process`)
    return run
  }

  private normalizeProjectSettings(settings: FactoryProjectSettings): FactoryProjectSettings {
    const model = settings.model?.trim()
    const titleModel = settings.titleModel?.trim()
    const baseRef = settings.lane.baseRef?.trim()
    const setupCommand = settings.setupCommand?.trim()
    const titlePrompt = settings.titlePrompt?.trim()
    const descriptionPrompt = settings.descriptionPrompt?.trim()
    if ((titlePrompt?.length ?? 0) > 4_000 || (descriptionPrompt?.length ?? 0) > 4_000) throw new Error('Factory metadata instructions cannot exceed 4000 characters')
    return {
      autoTitle: settings.autoTitle,
      lane: {
        mode: settings.lane.mode,
        ...(settings.lane.mode === 'isolated' && baseRef !== undefined && baseRef !== '' ? { baseRef } : {}),
      },
      ...(model === undefined || model === '' ? {} : { model }),
      ...(titleModel === undefined || titleModel === '' ? {} : { titleModel }),
      ...(titlePrompt === undefined || titlePrompt === '' ? {} : { titlePrompt }),
      ...(descriptionPrompt === undefined || descriptionPrompt === '' ? {} : { descriptionPrompt }),
      ...(setupCommand === undefined || setupCommand === '' ? {} : { setupCommand }),
    }
  }

  private ensureInboxFlow(document: FactoryDocument, project: FactoryProject, now: string): FactoryFlow {
    const matches = document.flows.filter(flow => flow.projectId === project.id && flow.kind === 'inbox')
    if (matches.length > 1) throw new Error(`Factory project ${project.id} has multiple emerging-work flows`)
    const existing = matches[0]
    if (existing !== undefined) {
      existing.title = EMERGING_WORK_TITLE
      existing.description = EMERGING_WORK_DESCRIPTION
      existing.updatedAt = now
      return existing
    }
    const flow: FactoryFlow = {
      id: FactoryFlowId(identity('flow')), projectId: project.id, kind: 'inbox',
      title: EMERGING_WORK_TITLE, description: EMERGING_WORK_DESCRIPTION,
      taskIds: [], status: 'draft', createdAt: now, updatedAt: now,
    }
    document.flows.push(flow)
    return flow
  }

  private projectLane(project: FactoryProject): FactoryTask['lane'] {
    return {
      mode: project.settings.lane.mode,
      ...(project.settings.lane.mode === 'isolated' && project.settings.lane.baseRef !== undefined
        ? { baseRef: project.settings.lane.baseRef }
        : {}),
    }
  }

  private metadataRoute(project: FactoryProject): { provider: string; model: string } {
    const selected = project.settings.titleModel ?? project.settings.model
    const fallback = this.ctx.agentDefaultModel.currentSelection()
    if (selected === undefined) return { provider: fallback.provider, model: fallback.model }
    const boundary = selected.indexOf(':')
    return boundary <= 0
      ? { provider: fallback.provider, model: selected }
      : { provider: selected.slice(0, boundary), model: selected.slice(boundary + 1) }
  }

  private shouldGenerateMetadata(settings: FactoryProjectSettings, title: string | undefined, description: string | undefined): boolean {
    return this.config.titleGenerationEnabled && settings.autoTitle && (title === undefined || description === undefined)
  }

  private appendMetadataGeneration(
    document: FactoryDocument,
    projectId: FactoryProject['id'],
    target: FactoryMetadataGeneration['target'],
    request: FactoryMetadataRequest,
    now: string,
  ): FactoryMetadataGeneration {
    const generation: FactoryMetadataGeneration = {
      id: FactoryMetadataGenerationId(identity('metadata')), projectId, target, status: 'running',
      route: request.route, system: request.system, input: request.input, maxTokens: request.maxTokens,
      createdAt: now, updatedAt: now,
    }
    document.metadataGenerations.push(generation)
    if (document.metadataGenerations.length > this.config.metadataGenerationLimit) {
      document.metadataGenerations.splice(0, document.metadataGenerations.length - this.config.metadataGenerationLimit)
    }
    return generation
  }

  private async completeMetadataGeneration(
    generation: FactoryMetadataGeneration,
    request: FactoryMetadataRequest,
    fallback: { title: string; description: string },
    options: { replaceTitle: boolean; replaceDescription: boolean; mirroredFlowId?: FactoryFlow['id'] },
  ): Promise<FactorySnapshot> {
    let generated: Awaited<ReturnType<typeof generateFactoryMetadata>> | undefined
    let failure: string | undefined
    try {
      generated = await generateFactoryMetadata(this.ctx, request, this.config.metadataLimits)
    } catch (error: unknown) {
      failure = boundFactoryMetadataText(
        error instanceof Error ? error.message : String(error),
        this.config.metadataLimits.maxDescriptionBytes,
      )
      this.ctx.logger.warn(`Factory metadata generation failed: ${failure}`)
    }
    return this.commit({}, (document, now) => {
      const receipt = document.metadataGenerations.find(candidate => candidate.id === generation.id)
      if (receipt === undefined) throw new Error(`Factory metadata generation ${generation.id} does not exist`)
      receipt.updatedAt = now
      if (generated === undefined) {
        receipt.status = 'failed'
        receipt.error = failure ?? 'Factory metadata generation failed'
        return
      }
      receipt.status = 'succeeded'
      receipt.output = generated.output
      const task = expectTask(document, receipt.target.id)
      if (options.replaceTitle && task.title === fallback.title) task.title = generated.title
      if (options.replaceDescription && task.description === fallback.description) task.description = generated.description
      task.updatedAt = now
      if (options.mirroredFlowId !== undefined) {
        const flow = document.flows.find(candidate => candidate.id === options.mirroredFlowId)
        if (flow !== undefined) {
          if (flow.title === fallback.title) flow.title = generated.title
          if (flow.description === fallback.description) flow.description = generated.description
          flow.updatedAt = now
        }
      }
      activity(document, this.config.activityLimit, `${task.identifier} metadata generated`, 'task-metadata-generated', now, task)
    })
  }

  private defaultModel(): string {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    return `${selection.provider}:${selection.model}`
  }

  private replaceOptional(task: FactoryTask, key: 'preset' | 'model', value: string): void {
    if (value.trim() === '') delete task[key]
    else task[key] = value.trim()
  }

  private schedulePresence(): Promise<void> {
    if (this.publishing !== undefined) {
      this.publishAgain = true
      return this.publishing
    }
    this.publishing = this.publishPresence().catch((error: unknown) => {
      this.ctx.logger.warn(`Factory presence publication failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.publishing = undefined
      if (this.publishAgain) { this.publishAgain = false; void this.schedulePresence() }
    })
    return this.publishing
  }

  private async publishPresence(): Promise<void> {
    const stored = await this.ctx.factoryStore.read()
    const runs = new Map(stored.document.runs.flatMap(run => run.sessionId === undefined ? [] : [[run.sessionId, run] as const]))
    const tasks = new Map(stored.document.tasks.map(task => [task.id, task]))
    const heartbeatAt = iso()
    const liveAgents = this.ctx.agents.list()
    const activeSessionIds = new Set<string>(liveAgents.filter(agent => agent.session.events.some(event => event.type === 'user/message')).map(agent => agent.id))
    const observations = liveAgents.map(agent => this.observe(agent, runs.get(agent.id), tasks, heartbeatAt))
    await this.ctx.factoryStore.replaceAgentObservations(this.processId, observations)
    await this.reconcileObservedState(liveAgents)
    const projected = await this.snapshot()
    for (const observation of projected.agents.filter(agent => agent.taskId === undefined && agent.cwd !== undefined && activeSessionIds.has(agent.sessionId))) {
      try { await this.adoptSessions({ sessionIds: [observation.sessionId] }) }
      catch (error: unknown) {
        this.ctx.logger.warn(`Factory could not add Session ${observation.sessionId} to emerging work: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async reconcileObservedState(agents: readonly Agent[]): Promise<void> {
    const live = new Map<string, Agent>(agents.map(agent => [agent.id, agent]))
    let reconciled = false
    const stored = await this.ctx.factoryStore.mutate(undefined, (document) => {
      const now = iso()
      let changed = false
      for (const flow of document.flows) {
        if (flow.kind !== 'inbox' || (flow.title === EMERGING_WORK_TITLE && flow.description === EMERGING_WORK_DESCRIPTION)) continue
        flow.title = EMERGING_WORK_TITLE
        flow.description = EMERGING_WORK_DESCRIPTION
        flow.updatedAt = now
        changed = true
      }
      for (const run of document.runs) {
        if (run.origin !== 'observed' || run.processId !== this.processId || run.sessionId === undefined || !['dispatching', 'running', 'waiting'].includes(run.status)) continue
        const task = document.tasks.find(candidate => candidate.id === run.taskId && candidate.activeRunId === run.id)
        if (task === undefined) continue
        const agent = live.get(run.sessionId)
        if (agent === undefined) {
          const failure = 'Observed Session ended before factory_finish'
          run.status = 'failed'
          run.failure = failure
          run.finishedAt = now
          run.updatedAt = now
          task.status = 'failed'
          task.failure = failure
          task.updatedAt = now
          delete task.activeRunId
          activity(document, this.config.activityLimit, `${task.identifier} failed abruptly: ${failure}`, 'run-failed-abruptly', now, task)
          changed = true
        } else if (agent.status === 'running' && run.status !== 'running') {
          run.status = 'running'
          run.updatedAt = now
          task.status = 'running'
          task.updatedAt = now
          activity(document, this.config.activityLimit, `${task.identifier} started in ${run.sessionId}`, 'run-started', now, task)
          changed = true
        }
      }
      if (!changed) return FACTORY_STORE_NO_CHANGE
      reconciled = true
      deriveFlows(document, now)
    })
    if (reconciled) this.ctx.emit('factory/changed', stored.revision)
  }

  private observe(agent: Agent, run: FactoryRun | undefined, tasks: ReadonlyMap<FactoryTaskId, FactoryTask>, heartbeatAt: string): FactoryAgentObservation {
    const task = run === undefined ? undefined : tasks.get(run.taskId)
    const title = task?.title ?? this.ctx.sessionTitle.get(agent.session)?.title
    return {
      processId: this.processId, agentId: agent.id, sessionId: agent.id, status: agent.status, heartbeatAt,
      ...(task === undefined ? {} : { taskId: task.id }),
      ...(run === undefined ? {} : { runId: run.id }),
      ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
      ...(agent.session.header.agentPreset === undefined ? {} : { preset: agent.session.header.agentPreset }),
      ...(agent.options.provider === undefined ? {} : { provider: agent.options.provider }),
      ...(agent.options.model === undefined ? {} : { model: agent.options.model }),
      ...(title === undefined ? {} : { title }),
      ...(agent.session.header.origin === undefined ? {} : { origin: agent.session.header.origin }),
      ...(agent.session.header.delegationDepth === undefined ? {} : { delegationDepth: agent.session.header.delegationDepth }),
    }
  }
}

export default FactoryDomain

declare module '@monotykamary/cordis' {
  interface Context {
    factory: FactoryDomain
  }
  interface Events {
    /** @mode emit @param revision Newly committed Factory revision. */
    'factory/changed'(revision: number): void
  }
}
