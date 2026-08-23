import type { SessionId } from '@monotykamary/dsh-client-runtime/client'
import type { ComposerSubmissionMiddleware } from '@monotykamary/dsh-client-ui-conversation/client'
import type {
  FactoryAttachmentInput, FactoryFlowId, FactoryFlowIntakePlacement, FactoryFlowStatus, FactoryTaskId,
} from 'dsh-factory-protocol'
import type { FactoryRemote } from './factory-client.ts'
import { remoteValue } from './factory-client.ts'

/** New Session's Emerging-work or Factory-flow submission intent. */
export type FactorySessionIntent =
  | { readonly kind: 'task'; readonly run: 'now' | 'later' }
  | { readonly kind: 'new-flow' }
  | { readonly kind: 'flow'; readonly flowId: FactoryFlowId; readonly flowTitle: string; readonly placement: FactoryFlowIntakePlacement }

/** Existing flow offered for the current Session workspace. */
export interface FactoryIntentFlow {
  readonly id: FactoryFlowId
  readonly title: string
  readonly status: FactoryFlowStatus
}

/** Picker state scoped to one blank Session. */
export interface FactoryIntentState {
  readonly intent: FactorySessionIntent
  readonly flows: readonly FactoryIntentFlow[]
  readonly loading: boolean
  readonly error?: string
}

class LocalStore<T> {
  private value: T
  private readonly listeners = new Set<() => void>()

  constructor(initial: T) { this.value = initial }

  readonly getSnapshot = (): T => this.value
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(value: T): void {
    if (Object.is(this.value, value)) return
    this.value = value
    for (const listener of this.listeners) listener()
  }
}

/** Per-session intent controller used by the picker and submission middleware. */
export class FactoryIntentController {
  readonly store = new LocalStore<FactoryIntentState>({
    intent: { kind: 'task', run: 'now' }, flows: [], loading: false,
  })
  private loadGeneration = 0

  constructor(private readonly api: FactoryRemote, private readonly projectPath: () => string | undefined) {}

  /** Current staged intent. */
  get intent(): FactorySessionIntent { return this.store.getSnapshot().intent }

  /** Stage one intent without changing the draft or current Session. */
  select(intent: FactorySessionIntent): void {
    this.store.set({ ...this.store.getSnapshot(), intent })
  }

  /** Return to immediate Emerging-work capture after successful staged intake. */
  reset(): void { this.select({ kind: 'task', run: 'now' }) }

  /** Refresh nonterminal named flows for this Session's workspace. */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    const current = this.store.getSnapshot()
    this.store.set({ intent: current.intent, flows: current.flows, loading: true })
    try {
      const snapshot = remoteValue(await this.api.snapshot())
      if (generation !== this.loadGeneration) return
      const path = this.projectPath()
      const project = snapshot.document.projects.find(candidate => candidate.mainPath === path)
      const flows = project === undefined ? [] : snapshot.document.flows
        .filter(flow => flow.projectId === project.id && flow.kind === 'standard' && !['succeeded', 'failed', 'cancelled'].includes(flow.status))
        .map(flow => ({ id: flow.id, title: flow.title, status: flow.status }))
      this.store.set({ intent: this.store.getSnapshot().intent, flows, loading: false })
    } catch (error: unknown) {
      if (generation !== this.loadGeneration) return
      this.store.set({
        ...this.store.getSnapshot(), loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** Local route state shared by composer intake and the Factory application. */
export class FactoryNavigation {
  readonly store = new LocalStore<{ readonly taskId?: FactoryTaskId }>({})

  constructor(private readonly openSurface: () => void) {}

  /** Open one Factory task card and select the Factory application. */
  openTask(taskId: FactoryTaskId): void {
    this.store.set({ taskId })
    this.openSurface()
  }

  /** Return the Factory application to its Work overview. */
  openWork(): void { this.store.set({}) }
}

async function readAttachment(file: File, signal: AbortSignal): Promise<FactoryAttachmentInput> {
  if (signal.aborted) throw signal.reason
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    const abort = (): void => { reader.abort(); reject(signal.reason) }
    const cleanup = (): void => { signal.removeEventListener('abort', abort) }
    signal.addEventListener('abort', abort, { once: true })
    reader.onerror = () => { cleanup(); reject(reader.error ?? new Error(`Unable to read ${file.name}`)) }
    reader.onload = () => {
      cleanup()
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error(`Unable to read ${file.name}`))
    }
    reader.readAsDataURL(file)
  })
  return { name: file.name, mediaType: file.type, dataUrl }
}

/** Build Factory's wrapper around the ordinary New Session send path. */
export function factorySubmissionMiddleware(options: {
  readonly api: FactoryRemote
  readonly controllerFor: (sessionId: SessionId) => FactoryIntentController
  readonly navigation: FactoryNavigation
}): ComposerSubmissionMiddleware {
  return {
    order: -100,
    async submit(request, next) {
      const controller = options.controllerFor(request.sessionId)
      const intent = controller.intent
      if (intent.kind === 'task' && intent.run === 'now') return next()
      const attachments = await Promise.all(request.images.map(image => readAttachment(image, request.signal)))
      const destination = intent.kind === 'flow'
        ? { destination: 'flow' as const, flowId: intent.flowId, placement: intent.placement }
        : { destination: intent.kind === 'task' ? 'task' as const : intent.kind }
      const result = remoteValue(await options.api.intakeSession({
        sessionId: request.sessionId, prompt: request.text, attachments, ...destination,
      }))
      if (!result.snapshot.document.tasks.some(task => task.id === result.taskId)) {
        throw new Error(`Factory intake returned missing task ${result.taskId}`)
      }
      controller.reset()
      options.navigation.openTask(result.taskId)
      return { kind: 'success' }
    },
  }
}
