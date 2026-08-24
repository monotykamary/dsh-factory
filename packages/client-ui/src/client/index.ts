/** Factory browser entrypoint: generated Remote namespace plus root UI seats. */
import type { ConnectionHandle } from '@monotykamary/dsh-api-remotes/client'
import type { ClientContext, SessionId } from '@monotykamary/dsh-client-runtime/client'
import type {} from '@monotykamary/dsh-client-locale/client'
import type {} from '@monotykamary/dsh-client-ui-conversation/client'
import type {} from '@monotykamary/dsh-client-ui-layout/client'
import type {} from '@monotykamary/dsh-client-ui-sidebar/client'
import type { SessionDispositionContract } from '@monotykamary/dsh-client-ui-workspace/client'
import factoryRemote from 'dsh-factory-domain/remote'
import { FactoryApp } from './FactoryApp.tsx'
import type { FactoryAppInjected } from './FactoryApp.tsx'
import { FactoryIntentSelect } from './FactoryIntentSelect.tsx'
import { FactoryIntentController, FactoryNavigation, factorySubmissionMiddleware } from './factory-intake.ts'
import type { FactoryRemote } from './factory-client.ts'
import { FactoryNav } from './FactoryNav.tsx'
import { en, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'remote', 'connection', 'conversation', 'layout', 'sessions', 'sessionDisposition']

declare module '@monotykamary/dsh-client-ui-layout/client' {
  interface ApplicationSurfaceMap {
    factory: never
  }
}

/** Mount Factory Remote codecs before exposing navigation and application seats. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(factoryRemote)
  const api = ctx.get('remote.factory') as FactoryRemote | undefined
  const connection = ctx.get('connection') as ConnectionHandle
  const sessionDisposition = ctx.get('sessionDisposition') as SessionDispositionContract
  if (api === undefined) {
    await disposeRemote()
    throw new Error('dsh-factory: generated Remote namespace did not activate')
  }
  const navigation = new FactoryNavigation(() => { ctx.layout.openApplicationSurface('factory') })
  const controllers = new Map<SessionId, FactoryIntentController>()
  const controllerFor = (sessionId: SessionId): FactoryIntentController => {
    const existing = controllers.get(sessionId)
    if (existing !== undefined) return existing
    const created = new FactoryIntentController(api, () => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd)
    controllers.set(sessionId, created)
    ctx.sessions.binding(sessionId)?.ctx.effect(() => () => { controllers.delete(sessionId) }, 'dsh-factory: Session intent controller')
    return created
  }
  const disposeLocale = ctx.locale.register('factory', { en, zh })
  const disposeSubmission = ctx.conversation.submissions.register(factorySubmissionMiddleware({
    api,
    controllerFor,
    navigation,
    clearDraft: (sessionId) => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`dsh-factory: cannot clear unavailable Session ${sessionId}`)
      ctx.conversation.input.for(binding.ctx).setDraft('')
    },
  }))
  const disposeIntent = ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'factory-intent', order: -100, locale: 'factory',
    inject: sessionId => ({ controller: controllerFor(sessionId) }),
  }, FactoryIntentSelect))
  const disposeSurface = ctx.slots.register({
    name: 'application.surface',
    priority: 10,
    select: owner => owner.activeSurface === 'factory' ? true : null,
    locale: 'factory',
    inject: (): FactoryAppInjected => ({
      api, modelApi: connection.api.llm, sessionRuntime: ctx.sessions, navigation,
      settleSession: sessionId => { sessionDisposition.settleSession(sessionId) },
      unsettleSession: sessionId => { sessionDisposition.unsettleSession(sessionId) },
      archiveSession: async sessionId => { await ctx.workspaces.archiveSession(sessionId) },
      hooks: { sessionDisposition: sessionDisposition.state },
    }),
  }, FactoryApp)
  const disposeNavigation = ctx.slots.register({
    name: 'sidebar.navigation', id: 'factory', order: 10, label: () => ctx.locale.bind('factory')('nav'), locale: 'factory',
  }, FactoryNav)
  return async () => {
    disposeNavigation()
    disposeIntent()
    disposeSubmission()
    controllers.clear()
    disposeSurface()
    disposeLocale()
    await disposeRemote()
  }
}
