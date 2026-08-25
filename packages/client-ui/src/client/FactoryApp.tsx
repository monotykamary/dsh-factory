import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { IApiClient } from '@monotykamary/dsh-api-remotes/client'
import type { ISessions, SessionId } from '@monotykamary/dsh-client-runtime/client'
import {
  Button, ChevronDown, ChevronRight, CircleDashed, GitBranch, Input, ListChecks, LoaderCircle,
  Pill, Play, RefreshCw, Rows2, Search, Settings, TriangleAlert, Undo2,
} from '@monotykamary/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@monotykamary/dsh-client-ui-slots'
import type { SessionDispositionSnapshot } from '@monotykamary/dsh-client-ui-workspace/client'
import {
  orderTaskGraph,
  type FactoryAttachSessionRequest, type FactoryCommentRequest, type FactoryConnectRequest,
  type FactoryFlow, type FactoryPriority, type FactoryReviewRunsRequest, type FactoryRun, type FactorySnapshot,
  type FactoryTask, type FactoryTaskActionRequest, type FactoryTaskStatus, type FactoryUpdateProjectRequest, type FactoryUpdateTaskRequest,
} from 'dsh-factory-protocol'
import { FactorySettings } from './FactorySettings.tsx'
import { FactoryTaskCard } from './FactoryTaskCard.tsx'
import { FactoryTriage } from './FactoryTriage.tsx'
import { type FactoryRemote, useFactory, useFactoryModels } from './factory-client.ts'
import type { FactoryNavigation } from './factory-intake.ts'
import { allowedTaskStatusTargets, PriorityPicker, QueueGraphCell, StatusPicker, TaskLabels } from './FactoryTaskVisuals.tsx'
import css from './FactoryApp.module.css'

/** Dynamic dependencies injected into the Factory root surface before renderer binding. */
export type FactoryAppInjected = {
  hooks: { sessionDisposition: HostObservable<SessionDispositionSnapshot> }
  api: FactoryRemote
  modelApi: IApiClient['llm']
  sessionRuntime: ISessions
  navigation: FactoryNavigation
  settleSession: (sessionId: SessionId) => void
  unsettleSession: (sessionId: SessionId) => void
  archiveSession: (sessionId: SessionId) => Promise<void>
}

/** Renderer props for the Factory root surface. */
export type FactoryAppProps = PropsRuntime<'application.surface'>
  & PropsLocale<'factory'>
  & { matched: true }
  & Omit<FactoryAppInjected, 'hooks'>
  & PropsHooks<FactoryAppInjected['hooks']>

type Tab = 'work' | 'triage' | 'settings'
type Filter = 'all' | 'active' | 'scheduled' | 'waiting' | 'done'

function matchesFilter(task: FactoryTask, filter: Filter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return ['queued', 'dispatching', 'running'].includes(task.status)
  if (filter === 'scheduled') return task.status === 'scheduled'
  if (filter === 'waiting') return ['draft', 'waiting', 'paused'].includes(task.status)
  return ['succeeded', 'failed', 'cancelled'].includes(task.status)
}

function TaskRow({ task, graphTasks, project, priorityCounts, statusCounts, onOpen, onPriority, onStatus, onUnsettle, unsettleLabel, unsettleAriaLabel }: {
  task: FactoryTask
  graphTasks: readonly FactoryTask[]
  project?: string | undefined
  priorityCounts: ReadonlyMap<FactoryPriority, number>
  statusCounts: ReadonlyMap<FactoryTaskStatus, number>
  onOpen: () => void
  onPriority: (priority: FactoryPriority) => Promise<void>
  onStatus: (status: FactoryTaskStatus) => Promise<void>
  onUnsettle?: (() => void) | undefined
  unsettleLabel?: string | undefined
  unsettleAriaLabel?: string | undefined
}) {
  const allowedStatuses = allowedTaskStatusTargets(task)
  return (
    <div className={`${css.taskRow} ${onUnsettle === undefined ? '' : css.restorableTaskRow}`} data-testid={`factory-task-${task.identifier}`}>
      <PriorityPicker priority={task.priority} counts={priorityCounts} disabled={task.activeRunId !== undefined} onChange={onPriority} />
      <button type="button" className={css.taskIdentifierButton} onClick={onOpen}>{task.identifier}</button>
      <StatusPicker status={task.status} counts={statusCounts} allowed={allowedStatuses} onChange={onStatus} />
      <button type="button" className={css.taskRowOpen} onClick={onOpen}>
        <span className={css.taskTitle}>{task.title}</span>
        <TaskLabels labels={task.labels} />
        <span className={`${css.taskMeta} ${css.projectMeta}`}>{project}</span>
        <span className={`${css.taskMeta} ${css.laneMeta}`}><GitBranch size={12} />{task.lane.mode}</span>
        <QueueGraphCell task={task} tasks={graphTasks} />
        <ChevronRight size={14} className={css.rowChevron} />
      </button>
      {onUnsettle === undefined ? null : (
        <Button className={css.unsettleTask} aria-label={unsettleAriaLabel} variant="ghost" size="sm" icon={<Undo2 size={13} />} onClick={onUnsettle}>{unsettleLabel}</Button>
      )}
    </div>
  )
}

/** Render durable Factory work under the effective Session lifecycle projection. */
export function WorkView({
  snapshot, query, filter, settledSessionIds, snoozedUntilBySession, archivedSessionIds,
  t, onOpen, onPriority, onStatus, onStartFlow, onUnsettle,
}: {
  snapshot: FactorySnapshot
  query: string
  filter: Filter
  settledSessionIds: readonly SessionId[]
  snoozedUntilBySession: SessionDispositionSnapshot['snoozedUntilBySession']
  archivedSessionIds: readonly SessionId[]
  t: FactoryAppProps['t']
  onOpen: (id: FactoryTask['id']) => void
  onPriority: (taskId: FactoryTask['id'], priority: FactoryPriority) => Promise<void>
  onStatus: (task: FactoryTask, status: FactoryTaskStatus) => Promise<void>
  onStartFlow: (flowId: FactoryFlow['id']) => Promise<void>
  onUnsettle: (sessionId: SessionId) => void
}) {
  const [settledExpanded, setSettledExpanded] = useState(false)
  const normalized = query.trim().toLowerCase()
  const flowByTask = new Map(snapshot.document.flows.flatMap(flow => flow.taskIds.map(taskId => [taskId, flow] as const)))
  const latestSessionRunByTask = new Map<FactoryTask['id'], FactoryRun>()
  for (const run of snapshot.document.runs) {
    if (run.sessionId === undefined) continue
    const existing = latestSessionRunByTask.get(run.taskId)
    if (existing === undefined || run.startedAt >= existing.startedAt) latestSessionRunByTask.set(run.taskId, run)
  }
  const settledSessions = new Set(settledSessionIds)
  const archivedSessions = new Set(archivedSessionIds)
  const dispositionOf = (task: FactoryTask): 'active' | 'settled' | 'hidden' => {
    const sessionId = latestSessionRunByTask.get(task.id)?.sessionId as SessionId | undefined
    if (sessionId === undefined) return 'active'
    if (archivedSessions.has(sessionId) || snoozedUntilBySession[sessionId] !== undefined) return 'hidden'
    return settledSessions.has(sessionId) ? 'settled' : 'active'
  }
  const matched = snapshot.document.tasks.filter(task => {
    const flow = flowByTask.get(task.id)
    return matchesFilter(task, filter) && (
      normalized === '' || task.identifier.toLowerCase().includes(normalized) || task.title.toLowerCase().includes(normalized)
      || task.description.toLowerCase().includes(normalized) || task.labels.some(label => label.toLowerCase().includes(normalized))
      || flow?.title.toLowerCase().includes(normalized) === true || flow?.description.toLowerCase().includes(normalized) === true
    )
  })
  const shown = matched.filter(task => dispositionOf(task) === 'active')
  const settledTasks = matched.filter(task => dispositionOf(task) === 'settled')
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const shownIds = new Set(shown.map(task => task.id))
  const allTasks = new Map(snapshot.document.tasks.map(task => [task.id, task]))
  const projects = new Map(snapshot.document.projects.map(project => [project.id, project]))
  const flowTaskIds = new Set(snapshot.document.flows.flatMap(flow => flow.taskIds))
  const standalone = orderTaskGraph(shown.filter(task => !flowTaskIds.has(task.id)))
  const priorityCounts = new Map<FactoryPriority, number>([0, 1, 2, 3, 4].map(priority => [priority as FactoryPriority, snapshot.document.tasks.filter(task => task.priority === priority).length]))
  const statusCounts = new Map<FactoryTaskStatus, number>()
  for (const task of snapshot.document.tasks) statusCounts.set(task.status, (statusCounts.get(task.status) ?? 0) + 1)
  if (shown.length === 0 && settledTasks.length === 0) return <div className={css.emptyState}><Rows2 size={30} /><span>{t('empty')}</span></div>
  const row = (task: FactoryTask, graphTasks: readonly FactoryTask[], project?: string, settledSessionId?: SessionId) => (
    <TaskRow
      key={task.id} task={task} graphTasks={graphTasks} project={project}
      priorityCounts={priorityCounts} statusCounts={statusCounts}
      onOpen={() => { onOpen(task.id) }} onPriority={priority => onPriority(task.id, priority)} onStatus={status => onStatus(task, status)}
      {...(settledSessionId === undefined ? {} : {
        onUnsettle: () => { onUnsettle(settledSessionId) },
        unsettleLabel: t('emerging.unsettle'),
        unsettleAriaLabel: t('emerging.unsettleTask', { title: task.title }),
      })}
    />
  )
  const orderedFlows = snapshot.document.flows.toSorted((left, right) =>
    Number(left.kind !== 'inbox') - Number(right.kind !== 'inbox'))
  return (
    <div className={css.workGroups}>
      {orderedFlows.map((flow) => {
        const graphTasks = orderTaskGraph(flow.taskIds.flatMap(id => allTasks.get(id) ?? []))
        const canStart = flow.kind === 'standard' && flow.status === 'draft' && graphTasks.some(task => task.status === 'draft' && (task.automation === undefined || !task.automation.enabled))
        const tasks = graphTasks.filter(task => shownIds.has(task.id))
        if (tasks.length === 0) return null
        const project = projects.get(flow.projectId)
        return (
          <section className={css.taskGroup} key={flow.id} data-flow-kind={flow.kind}>
            <header className={css.groupHeader}>
              <div><ListChecks size={15} /><strong>{flow.title}</strong><span>{flow.status}</span></div>
              <div><small>{flow.kind === 'inbox' ? `${project?.title ?? ''} · new Session intake` : flow.status === 'scheduled' ? `${project?.title ?? ''} · recurring` : `${project?.title ?? ''} · ${String(graphTasks.filter(task => task.status === 'succeeded').length)}/${String(graphTasks.length)} complete`}</small>{canStart ? <Button variant="outline" size="sm" icon={<Play size={12} />} onClick={() => { void onStartFlow(flow.id) }}>Start flow</Button> : null}</div>
            </header>
            <div className={css.taskRows}>{tasks.map(task => row(task, tasks, project?.title))}</div>
          </section>
        )
      })}
      {standalone.length === 0 ? null : (
        <section className={css.taskGroup}>
          <header className={css.groupHeader}><div><CircleDashed size={15} /><strong>Standalone tasks</strong><span>{standalone.length}</span></div></header>
          <div className={css.taskRows}>{standalone.map(task => row(task, [task], projects.get(task.projectId)?.title))}</div>
        </section>
      )}
      {settledTasks.length === 0 ? null : (
        <section className={css.taskGroup} data-testid="factory-settled-emerging">
          <button
            type="button"
            className={css.settledEmergingToggle}
            aria-expanded={settledExpanded || normalized !== ''}
            onClick={() => { setSettledExpanded(value => !value) }}
          >
            <span><ListChecks size={15} /><strong>{t('emerging.settled')}</strong><em>{settledTasks.length}</em></span>
            <span><small>{t('emerging.settledCount', { count: settledTasks.length })}</small><ChevronDown size={14} aria-hidden="true" /></span>
          </button>
          {settledExpanded || normalized !== '' ? (
            <div className={css.taskRows}>
              {settledTasks.map((task) => {
                const flow = flowByTask.get(task.id)
                const graphTasks = flow === undefined
                  ? [task]
                  : orderTaskGraph(flow.taskIds.flatMap(id => allTasks.get(id) ?? []))
                const sessionId = latestSessionRunByTask.get(task.id)?.sessionId as SessionId
                return row(task, graphTasks, projects.get(task.projectId)?.title, sessionId)
              })}
            </div>
          ) : null}
        </section>
      )}
    </div>
  )
}

/** Full root Factory application surface. */
export function FactoryApp({
  api, modelApi, sessionRuntime, navigation, t, useSessions, useWorkspaces, useSessionDisposition,
  settleSession, unsettleSession, archiveSession, openSurface,
}: FactoryAppProps) {
  const factory = useFactory(api)
  const models = useFactoryModels(modelApi, factory.snapshot?.defaultModel)
  const workspaces = useWorkspaces(state => state.items)
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const settledSessionIds = useSessionDisposition(state => state.settledSessionIds)
  const snoozedUntilBySession = useSessionDisposition(state => state.snoozedUntilBySession)
  const unavailableDependencySessionIds = new Set<string>([
    ...settledSessionIds, ...archivedSessionIds, ...Object.keys(snoozedUntilBySession),
  ])
  const sessionList = useSessions(state => state)
  const [tab, setTab] = useState<Tab>('work')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [settingsPath, setSettingsPath] = useState<string>()
  const route = useSyncExternalStore(fn => navigation.store.subscribe(fn), () => navigation.store.getSnapshot())

  const snapshot = factory.snapshot
  const task = snapshot?.document.tasks.find(candidate => candidate.id === route.taskId)
  const activeRun = task?.activeRunId === undefined
    ? undefined
    : snapshot?.document.runs.find(candidate => candidate.id === task.activeRunId)
  const assigned = task === undefined ? undefined : snapshot?.agents.find(candidate => candidate.taskId === task.id)
  const latestRun = task === undefined
    ? undefined
    : snapshot?.document.runs.filter(candidate => candidate.taskId === task.id && candidate.sessionId !== undefined)
      .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
  const artifactRunId = activeRun?.id ?? latestRun?.id
  const taskSessionId = task?.activeRunId === undefined
    ? task?.output?.sessionId ?? latestRun?.sessionId
    : activeRun?.sessionId ?? assigned?.sessionId
  const listedTaskSessionId = taskSessionId !== undefined && sessionList.byId[taskSessionId as SessionId] !== undefined
    ? taskSessionId as SessionId
    : undefined
  const taskSession = listedTaskSessionId === undefined
    ? undefined
    : sessionRuntime.binding(listedTaskSessionId)?.session
  const taskSessionKey = taskSessionId as SessionId | undefined
  const taskSessionSettled = taskSessionKey !== undefined && settledSessionIds.includes(taskSessionKey)
  const taskSessionArchived = taskSessionKey !== undefined && archivedSessionIds.includes(taskSessionKey)
  useEffect(() => {
    if (listedTaskSessionId !== undefined) sessionRuntime.open(listedTaskSessionId)
  }, [listedTaskSessionId, sessionRuntime])
  const metrics = useMemo(() => {
    const tasks = snapshot?.document.tasks ?? []
    return {
      active: tasks.filter(item => ['queued', 'dispatching', 'running'].includes(item.status)).length,
      scheduled: tasks.filter(item => item.status === 'scheduled').length,
      waiting: tasks.filter(item => ['draft', 'waiting', 'paused'].includes(item.status)).length,
      done: tasks.filter(item => item.status === 'succeeded').length,
    }
  }, [snapshot])

  if (factory.loading && snapshot === undefined) return <div className={css.loading}><LoaderCircle size={20} />{t('loading')}</div>
  if (snapshot === undefined) return <div className={css.loading}><TriangleAlert size={20} />{factory.error ?? 'Factory unavailable'}</div>

  const unreadRuns = snapshot.document.runs.filter(run => run.reviewedAt === undefined && ['succeeded', 'failed', 'cancelled'].includes(run.status))
  const update = async (request: FactoryUpdateTaskRequest): Promise<void> => { await factory.mutate(() => api.updateTask(request)) }
  const comment = async (request: FactoryCommentRequest): Promise<void> => { await factory.mutate(() => api.comment(request)) }
  const connect = async (request: FactoryConnectRequest): Promise<void> => { await factory.mutate(() => api.connect(request)) }
  const attach = async (request: FactoryAttachSessionRequest): Promise<void> => { await factory.mutate(() => api.attachSession(request)) }
  const reviewRuns = async (request: FactoryReviewRunsRequest): Promise<void> => { await factory.mutate(() => api.reviewRuns(request)) }
  const updateProject = async (request: FactoryUpdateProjectRequest): Promise<void> => { await factory.mutate(() => api.updateProject(request)) }
  const action = async (name: 'enqueue' | 'pause' | 'cancel' | 'retry', request: FactoryTaskActionRequest): Promise<void> => {
    const call = name === 'enqueue' ? api.enqueue(request) : name === 'pause' ? api.pause(request) : name === 'cancel' ? api.cancel(request) : api.retry(request)
    await factory.mutate(() => call)
  }

  if (task !== undefined) return (
    <>
      {factory.error === undefined ? null : <div className={css.errorBanner} role="alert">{factory.error}</div>}
      <FactoryTaskCard
        task={task}
        snapshot={snapshot}
        modelChoices={models.choices}
        artifactApi={api}
        artifactRunId={artifactRunId}
        artifactRefreshToken={String(snapshot.revision)}
        session={taskSession}
        sessionId={taskSessionId}
        t={t}
        excludedDependencySessionIds={unavailableDependencySessionIds}
        sessionSettled={taskSessionSettled}
        sessionArchived={taskSessionArchived}
        onBack={() => { navigation.openWork() }}
        onOpenSession={listedTaskSessionId === undefined ? undefined : () => { openSurface('conversation'); sessionRuntime.open(listedTaskSessionId) }}
        onOpenSettings={(path) => { navigation.openWork(); setSettingsPath(path); setTab('settings') }}
        onSettleSession={taskSessionKey === undefined || taskSessionSettled || taskSessionArchived ? undefined : () => { settleSession(taskSessionKey); navigation.openWork() }}
        onArchiveSession={taskSessionKey === undefined || taskSessionArchived ? undefined : async () => { await archiveSession(taskSessionKey); navigation.openWork() }}
        onDeleteTask={async request => { await factory.mutate(() => api.deleteTask(request)) }}
        onUpdate={update}
        onComment={comment}
        onConnect={connect}
        onAttach={attach}
        onAction={action}
      />
    </>
  )

  return (
    <div className={css.root} data-testid="factory-app">
      <header className={css.topbar}>
        <div className={css.titleBlock}><div><h1>{t('title')}</h1><span>{metrics.active} active · {metrics.scheduled} scheduled · {metrics.waiting} waiting · {metrics.done} complete</span></div></div>
        <div className={css.topActions}>
          <Button className={css.refreshButton} aria-label={t('refresh')} variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => { void factory.refresh() }}>{t('refresh')}</Button>
        </div>
      </header>

      <nav className={css.tabs} aria-label="Factory views">
        <button type="button" data-active={tab === 'work' || undefined} onClick={() => { setTab('work') }}><CircleDashed size={14} />{t('work')}</button>
        <button type="button" data-active={tab === 'triage' || undefined} onClick={() => { setTab('triage') }}><ListChecks size={14} />Triage{unreadRuns.length === 0 ? null : <span>{unreadRuns.length}</span>}</button>
        <button type="button" data-active={tab === 'settings' || undefined} onClick={() => { setTab('settings') }}><Settings size={14} />{t('settings')}</button>
      </nav>

      {factory.error === undefined ? null : <div className={css.errorBanner} role="alert"><TriangleAlert size={14} />{factory.error}</div>}

      {tab === 'work' ? (
        <div className={css.workView}>
          <div className={css.filters}>
            <Input icon={<Search size={14} />} placeholder={t('search')} value={query} onChange={event => { setQuery(event.target.value) }} />
            <div className={css.filterPills}>
              {(['all', 'active', 'scheduled', 'waiting', 'done'] as const).map(value => <Pill key={value} active={filter === value} onClick={() => { setFilter(value) }}>{value === 'all' ? 'All' : value === 'active' ? `Active ${String(metrics.active)}` : value === 'scheduled' ? `Scheduled ${String(metrics.scheduled)}` : value === 'waiting' ? `Waiting ${String(metrics.waiting)}` : `Done ${String(metrics.done)}`}</Pill>)}
            </div>
            <div className={css.leader}><span className={css.liveDot} data-status={snapshot.leader === undefined ? 'idle' : 'running'} /><span>{snapshot.leader === undefined ? 'Scheduler standby' : `${t('leader')} · ${snapshot.leader.processId.slice(-6)}`}</span></div>
          </div>
          <WorkView snapshot={snapshot} query={query} filter={filter} settledSessionIds={settledSessionIds} snoozedUntilBySession={snoozedUntilBySession} archivedSessionIds={archivedSessionIds} t={t} onUnsettle={unsettleSession} onOpen={taskId => { navigation.openTask(taskId) }} onStartFlow={async flowId => { await factory.mutate(() => api.startFlow({ flowId, expectedRevision: snapshot.revision })) }} onPriority={async (taskId, priority) => { await update({ taskId, priority, expectedRevision: snapshot.revision }) }} onStatus={async (item, status) => {
            const name = status === 'queued' || status === 'scheduled' ? (item.status === 'failed' || item.status === 'cancelled' ? 'retry' : 'enqueue') : status === 'paused' ? 'pause' : 'cancel'
            await action(name, { taskId: item.id, expectedRevision: snapshot.revision })
          }} />
        </div>
      ) : tab === 'triage' ? <FactoryTriage snapshot={snapshot} api={api} t={t} onOpenTask={taskId => { navigation.openTask(taskId) }} onReview={async runIds => { await reviewRuns({ runIds, expectedRevision: snapshot.revision }) }} /> : <FactorySettings snapshot={snapshot} workspaces={workspaces} choices={models.choices} modelError={models.modelError} initialPath={settingsPath} onSave={updateProject} />}
    </div>
  )
}
