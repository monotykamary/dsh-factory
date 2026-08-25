import { useEffect, useMemo, useState } from 'react'
import {
  Archive, Bot, Button, Check, ChevronLeft, ChevronRight, CircleCheck, CircleX, Clock3, GitBranch, MarkdownText,
  MessageSquareText, Paperclip, Pause, Play, RiskConfirmation, Settings, Trash2, Undo2,
} from '@monotykamary/dsh-client-ui-primitives'
import { ProducedFilesCard, type DeliverableChange } from '@monotykamary/dsh-client-ui-deliverables/client'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import type { SessionFace } from '@monotykamary/dsh-client-runtime/client'
import {
  resolveFactoryRetry,
  type FactoryAttachSessionRequest, type FactoryCommentRequest, type FactoryConnectRequest, type FactorySnapshot, type FactoryTask,
  type FactoryTaskActionRequest, type FactoryTaskStatus, type FactoryUpdateTaskRequest,
} from 'dsh-factory-protocol'
import {
  AutomationSelect, RecurringScheduleEditor, automationMode, automationRecurringValue, automationScheduleValue, automationSpec, automationSummary,
  type FactoryAutomationMode,
} from './FactoryAutomationControls.tsx'
import { FactoryArtifactMedia } from './FactoryArtifactMedia.tsx'
import { FactoryLabelSelect } from './FactoryLabelSelect.tsx'
import { FactoryMediaRail, type FactoryMediaRailLabels, type FactoryPreviewMedia } from './FactoryMediaRail.tsx'
import { FactoryModelSelect } from './FactoryModelSelect.tsx'
import { FactorySelectMenu } from './FactorySelectMenu.tsx'
import { FactoryTaskDiscussion } from './FactoryTaskDiscussion.tsx'
import {
  allowedTaskStatusTargets, PriorityPicker, priorityLabel, statusLabel, StatusPicker, TaskLabel, TaskModelPicker, TaskRetryPicker,
} from './FactoryTaskVisuals.tsx'
import type { FactoryModelChoice, FactoryRemote } from './factory-client.ts'
import css from './FactoryApp.module.css'

interface Props {
  task: FactoryTask
  snapshot: FactorySnapshot
  t: TranslateNS<'factory'>
  onBack: () => void
  modelChoices: readonly FactoryModelChoice[]
  artifactApi: Pick<FactoryRemote, 'artifactMedia' | 'artifactMediaData'>
  artifactRunId?: FactorySnapshot['document']['runs'][number]['id'] | undefined
  artifactRefreshToken: string
  session?: SessionFace | undefined
  sessionId?: string | undefined
  onOpenSession?: (() => void) | undefined
  onOpenSettings: (path: string) => void
  excludedDependencySessionIds: ReadonlySet<string>
  sessionSettled: boolean
  sessionArchived: boolean
  onSettleSession?: (() => void) | undefined
  onArchiveSession?: (() => Promise<void>) | undefined
  onDeleteTask: (request: FactoryTaskActionRequest) => Promise<void>
  onUpdate: (request: FactoryUpdateTaskRequest) => Promise<void>
  onAction: (action: 'enqueue' | 'pause' | 'cancel' | 'retry', request: FactoryTaskActionRequest) => Promise<void>
  onComment: (request: FactoryCommentRequest) => Promise<void>
  onConnect: (request: FactoryConnectRequest) => Promise<void>
  onAttach: (request: FactoryAttachSessionRequest) => Promise<void>
}

function terminal(status: FactoryTask['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

function latestTaskSessionId(snapshot: FactorySnapshot, task: FactoryTask): string | undefined {
  return snapshot.document.runs
    .filter(run => run.taskId === task.id && run.sessionId !== undefined)
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))[0]?.sessionId
}

function outputChanges(task: FactoryTask): DeliverableChange[] {
  return (task.output?.mutations ?? []).map(mutation => ({
    seq: mutation.commitOrder,
    commitOrder: mutation.commitOrder,
    turn: 0,
    callId: `factory:${String(mutation.commitOrder)}`,
    title: `${mutation.operation} ${mutation.path}`,
    diffs: mutation.diffs,
  }))
}

function actionForStatus(task: FactoryTask, status: FactoryTaskStatus): 'enqueue' | 'pause' | 'cancel' | 'retry' {
  if (status === 'queued' || status === 'scheduled') return task.status === 'failed' || task.status === 'cancelled' ? 'retry' : 'enqueue'
  return status === 'paused' ? 'pause' : 'cancel'
}

/** Circle-style Factory task page with prompt automation, properties, dependencies, discussion, and audit activity. */
export function FactoryTaskCard({
  task, snapshot, modelChoices, artifactApi, artifactRunId, artifactRefreshToken, session, sessionId, t,
  onBack, onOpenSession, onOpenSettings, excludedDependencySessionIds, sessionSettled, sessionArchived,
  onSettleSession, onArchiveSession, onDeleteTask, onUpdate, onAction, onComment, onConnect, onAttach,
}: Props) {
  const project = snapshot.document.projects.find(candidate => candidate.id === task.projectId)
  const effectiveModel = task.model ?? project?.settings.model ?? snapshot.defaultModel
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [prompt, setPrompt] = useState(task.prompt)
  const [model, setModel] = useState(effectiveModel)
  const [labels, setLabels] = useState<string[]>(task.labels)
  const [automationModeValue, setAutomationModeValue] = useState<FactoryAutomationMode>(automationMode(task.automation))
  const [scheduleAt, setScheduleAt] = useState(automationScheduleValue(task.automation))
  const [recurring, setRecurring] = useState(() => automationRecurringValue(task.automation))
  const [dependency, setDependency] = useState('')
  const [agent, setAgent] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false)

  useEffect(() => {
    if (editing) return
    setTitle(task.title); setDescription(task.description); setPrompt(task.prompt); setModel(effectiveModel)
    setLabels(task.labels); setAutomationModeValue(automationMode(task.automation)); setScheduleAt(automationScheduleValue(task.automation)); setRecurring(automationRecurringValue(task.automation))
  }, [editing, effectiveModel, task])
  const flow = snapshot.document.flows.find(candidate => candidate.id === task.flowId)
  const dependencies = task.dependencyIds.flatMap(id => snapshot.document.tasks.find(candidate => candidate.id === id) ?? [])
  const dependents = snapshot.document.tasks.filter(candidate => candidate.dependencyIds.includes(task.id))
  const candidates = snapshot.document.tasks.filter(candidate => {
    const linkedSessionId = latestTaskSessionId(snapshot, candidate)
    return candidate.id !== task.id
      && candidate.projectId === task.projectId
      && !task.dependencyIds.includes(candidate.id)
      && !candidate.finalizer
      && !terminal(candidate.status)
      && (linkedSessionId === undefined || !excludedDependencySessionIds.has(linkedSessionId))
      && (flow?.kind !== 'inbox' || candidate.flowId === flow.id)
  })
  const emerging = snapshot.agents.filter(candidate => candidate.taskId === undefined)
  const activities = snapshot.document.activities.filter(entry => entry.taskId === task.id && entry.kind !== 'comment-added').toReversed()
  const priorityCounts = new Map([0, 1, 2, 3, 4].map(priority => [priority as FactoryTask['priority'], snapshot.document.tasks.filter(candidate => candidate.priority === priority).length]))
  const statusCounts = new Map<FactoryTaskStatus, number>()
  for (const candidate of snapshot.document.tasks) statusCounts.set(candidate.status, (statusCounts.get(candidate.status) ?? 0) + 1)
  const labelOptions = [...new Set(snapshot.document.tasks.flatMap(candidate => candidate.labels))].toSorted((left, right) => left.localeCompare(right))
  const effectiveModelLabel = modelChoices.find(choice => choice.id === effectiveModel)?.label ?? effectiveModel
  const retryMode: 'inherit' | 'on' | 'off' = task.retry === undefined ? 'inherit' : task.retry.enabled === false ? 'off' : 'on'
  const retryPolicy = resolveFactoryRetry(task, project?.settings ?? {})
  const retryDetail = retryPolicy === undefined
    ? 'off'
    : `${String(retryPolicy.maxRetries)} retries from ${String(retryPolicy.backoffMs / 1_000)}s backoff`
  const retrySummary = retryMode === 'off' ? 'Retries off' : retryMode === 'on' ? `Retries on · ${retryDetail}` : `Retries inherit workspace · ${retryDetail}`
  const pendingRetry = task.retryAt !== undefined && task.status === 'queued' ? ` · next ${new Date(task.retryAt).toLocaleString()}` : ''
  const activeRunComments = task.activeRunId !== undefined
    && ['dispatching', 'running', 'waiting'].includes(task.status)
  const taskMedia = useMemo<FactoryPreviewMedia[]>(() => task.attachments.map(attachment => ({
    id: attachment.id,
    previewUrl: attachment.dataUrl,
    alt: attachment.name || t('image.pending'),
  })), [t, task.attachments])
  const taskMediaLabels = useMemo<FactoryMediaRailLabels>(() => ({
    group: t('image.group'),
    open: t('image.open'),
    scrollLeft: t('image.scrollLeft'),
    scrollRight: t('image.scrollRight'),
    dialog: t('image.preview'),
    close: t('image.closePreview'),
    previous: t('image.previous'),
    next: t('image.next'),
    position: (current, total) => t('image.position', { current: String(current), total: String(total) }),
  }), [t])

  const perform = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try { await operation() } finally { setBusy(false) }
  }

  const statusAction = useMemo(() => {
    if (task.status === 'failed' || task.status === 'cancelled') return 'retry' as const
    if (task.status === 'draft' || task.status === 'paused' || task.status === 'scheduled') return 'enqueue' as const
    if (task.status === 'queued' || task.status === 'waiting') return 'pause' as const
    return undefined
  }, [task.status])

  return (
    <div className={css.cardPage} data-testid="factory-task-card">
      <RiskConfirmation
        open={deleteOpen}
        title={t('deleteTaskTitle', { identifier: task.identifier })}
        description={t('deleteTaskDescription')}
        acknowledgeLabel={t('deleteTaskAcknowledge')}
        cancelLabel={t('deleteTaskCancel')}
        confirmLabel={t('deleteTaskConfirm')}
        acknowledged={deleteAcknowledged}
        disabled={busy}
        onAcknowledgedChange={setDeleteAcknowledged}
        onCancel={() => {
          if (busy) return
          setDeleteOpen(false)
          setDeleteAcknowledged(false)
        }}
        onConfirm={() => { void perform(async () => {
          await onDeleteTask({ taskId: task.id, expectedRevision: snapshot.revision })
          setDeleteOpen(false)
          setDeleteAcknowledged(false)
          onBack()
        }) }}
      />
      <header className={css.cardHeader}>
        <div className={css.cardBreadcrumb}>
          <Button variant="ghost" size="sm" icon={<ChevronLeft size={15} />} onClick={onBack}>{t('back')}</Button>
          <ChevronRight size={12} /><span>{project?.title ?? 'Factory'}</span>
          {flow === undefined ? null : <><ChevronRight size={12} /><span>{flow.title}</span></>}
          <ChevronRight size={12} /><strong>{task.identifier}</strong>
        </div>
        <div className={css.cardActions}>
          <span className={css.statusBadge} data-status={task.status} data-testid="factory-task-header-status">{statusLabel(task.status)}</span>
          {statusAction === undefined ? null : (
            <Button variant="ghost" size="sm" icon={statusAction === 'retry' ? <Undo2 size={14} /> : statusAction === 'pause' ? <Pause size={14} /> : <Play size={14} />} disabled={busy} onClick={() => { void perform(() => onAction(statusAction, { taskId: task.id, expectedRevision: snapshot.revision })) }}>
              {statusAction === 'retry' ? t('retry') : statusAction === 'pause' ? t('pause') : task.status === 'scheduled' ? 'Run now' : task.status === 'paused' && task.automation?.trigger.kind === 'recurring' ? 'Resume schedule' : t('queue')}
            </Button>
          )}
          {!terminal(task.status) ? <Button variant="ghost" size="sm" icon={<CircleX size={14} />} disabled={busy} onClick={() => { void perform(() => onAction('cancel', { taskId: task.id, expectedRevision: snapshot.revision })) }}>{t('stop')}</Button> : null}
          <Button variant="ghost" size="sm" aria-pressed={editing} onClick={() => { setEditing(value => !value) }}>{t('edit')}</Button>
        </div>
      </header>

      <div className={css.cardColumns}>
        <main className={css.cardMain}>
          <section className={css.issueHeading}>
            <div className={css.issueKicker}><span>{task.identifier}</span>{flow === undefined ? null : <span>{flow.title}</span>}</div>
            {editing ? <input className={css.titleInput} value={title} onChange={event => { setTitle(event.target.value) }} /> : <h1 className={css.issueTitle}>{task.title}</h1>}
            {editing ? <textarea className={css.descriptionEditor} value={description} onChange={event => { setDescription(event.target.value) }} placeholder="Add context…" /> : task.description === '' ? null : <div className={css.issueDescription}><MarkdownText text={task.description} /></div>}
          </section>

          <section className={css.cardSection}>
            <div className={css.sectionTitle}><Bot size={15} /><h2>{t('prompt')}</h2></div>
            {editing ? (
              <div className={css.taskPromptComposer}>
                <textarea className={css.taskPromptInput} value={prompt} onChange={event => { setPrompt(event.target.value) }} rows={5} placeholder="Tell the DSH Agent what to do…" />
                <div className={css.taskPromptSettings}>
                  <AutomationSelect value={automationModeValue} onChange={setAutomationModeValue} />
                  <FactoryModelSelect value={model} choices={modelChoices} ariaLabel={t('model')} onChange={setModel} />
                </div>
                {automationModeValue === 'schedule' ? <label className={css.stageSchedule}><span>Run once at</span><input type="datetime-local" value={scheduleAt} onChange={event => { setScheduleAt(event.target.value) }} /></label> : null}
                {automationModeValue === 'recurring' ? <RecurringScheduleEditor value={recurring} onChange={setRecurring} /> : null}
              </div>
            ) : <div className={css.promptDocument}><MarkdownText text={task.prompt} /></div>}
            {editing ? <div className={css.inlineActions}><Button variant="primary" size="sm" disabled={busy || title.trim() === '' || prompt.trim() === ''} onClick={() => { void perform(async () => {
              const automationChanged = automationModeValue !== automationMode(task.automation)
                || scheduleAt !== automationScheduleValue(task.automation)
                || JSON.stringify(recurring) !== JSON.stringify(automationRecurringValue(task.automation))
              const automation = automationChanged ? automationSpec(automationModeValue, scheduleAt, recurring) : undefined
              await onUpdate({ taskId: task.id, expectedRevision: snapshot.revision, title, description, prompt, model, labels, ...(automationChanged ? { automation: automation ?? null } : {}) })
              setEditing(false)
            }) }}>{t('save')}</Button></div> : null}
          </section>

          {taskMedia.length === 0 ? null : <section className={css.cardSection}><div className={css.sectionTitle}><Paperclip size={15} /><h2>{t('attachments')}</h2></div><FactoryMediaRail items={taskMedia} labels={taskMediaLabels} /></section>}

          <FactoryArtifactMedia api={artifactApi} taskId={task.id} runId={artifactRunId} refreshToken={artifactRefreshToken} surface="task" />

          {task.output === undefined ? null : (
            <section className={css.cardSection}>
              <div className={css.sectionTitle}><CircleCheck size={15} /><h2>{t('output')}</h2></div>
              <div className={css.outputDocument}><MarkdownText text={[task.output.summary, task.output.details].filter(Boolean).join('\n\n')} /></div>
              {task.output.artifacts.length === 0 ? null : <div className={css.artifactList}>{task.output.artifacts.map(value => <code key={value}>{value}</code>)}</div>}
              {task.output.mutations.length === 0 ? null : (
                <ProducedFilesCard
                  changes={outputChanges(task)}
                  labels={{
                    changed: count => t(count === 1 ? 'changes.changedOne' : 'changes.changed', { count: String(count) }),
                    viewFileDiff: path => t('changes.viewFileDiff', { name: path }),
                    expandFolders: t('changes.expandFolders'),
                    collapseFolders: t('changes.collapseFolders'),
                    viewDiff: t('changes.viewDiff'),
                  }}
                />
              )}
            </section>
          )}

          <FactoryTaskDiscussion task={task} revision={snapshot.revision} session={session} activeRun={activeRunComments} t={t} onOpenSession={onOpenSession} onComment={onComment} />

          {activities.length === 0 ? null : (
            <section className={css.cardSection}>
              <div className={css.sectionTitle}><MessageSquareText size={15} /><h2>{t('activity')}</h2></div>
              <div className={css.activityFeed}>
                {activities.map(item => <div className={css.activityEntry} key={item.id}><span /><div><strong>{item.message}</strong><time>{new Date(item.createdAt).toLocaleString()}</time></div></div>)}
              </div>
            </section>
          )}
        </main>

        <aside className={css.cardAside}>
          <section className={css.propertySection}>
            <h2>Properties</h2>
            <div className={css.propertyList}>
              <div className={css.propertyRow}><span className={css.propertyIcon}><StatusPicker status={task.status} counts={statusCounts} allowed={allowedTaskStatusTargets(task)} onChange={async status => { await perform(() => onAction(actionForStatus(task, status), { taskId: task.id, expectedRevision: snapshot.revision })) }} /></span><span>{statusLabel(task.status)}</span></div>
              <div className={css.propertyRow}><span className={css.propertyIcon}><PriorityPicker priority={task.priority} counts={priorityCounts} disabled={task.activeRunId !== undefined} onChange={async priority => { await onUpdate({ taskId: task.id, priority, expectedRevision: snapshot.revision }) }} /></span><span>{priorityLabel(task.priority)}</span></div>
              <div className={css.propertyRow}><span className={css.propertyIcon}><Clock3 size={15} /></span><span>{automationSummary(task.automation)}</span></div>
              <div className={css.propertyRow}>
                <span className={css.propertyIcon}>
                  <TaskRetryPicker mode={retryMode} disabled={busy} onChange={async next => { await onUpdate({ taskId: task.id, expectedRevision: snapshot.revision, retry: next === 'inherit' ? null : { enabled: next === 'on' } }) }} />
                </span>
                <span>{retrySummary}{pendingRetry}</span>
              </div>
              <div className={css.propertyRow}><span className={css.propertyIcon}><GitBranch size={15} /></span><span>{task.lane.mode}</span></div>
              <div className={css.propertyRow}>
                <span className={css.propertyIcon}>
                  <TaskModelPicker
                    value={effectiveModel}
                    choices={modelChoices}
                    disabled={busy}
                    onChange={async next => { await onUpdate({ taskId: task.id, model: next, expectedRevision: snapshot.revision }) }}
                  />
                </span>
                <span>{effectiveModelLabel}</span>
              </div>
              <div className={css.propertyRow}><span className={css.propertyIcon}><MessageSquareText size={15} /></span>{sessionId === undefined || onOpenSession === undefined ? <span>{sessionId ?? 'No Session'}</span> : <button type="button" className={css.sessionLink} aria-label={`Open Session ${sessionId}`} title={`Open Session ${sessionId}`} onClick={onOpenSession}>{sessionId}</button>}</div>
            </div>
          </section>

          {sessionId !== undefined ? (
            <section className={css.propertySection}>
              <h2>{t('disposition')}</h2>
              <div className={css.taskDispositionActions}>
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Check size={13} />}
                  disabled={busy || sessionSettled || sessionArchived || onSettleSession === undefined}
                  onClick={() => { onSettleSession?.() }}
                >{sessionSettled ? t('settled') : t('settle')}</Button>
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Archive size={13} />}
                  disabled={busy || sessionArchived || onArchiveSession === undefined}
                  onClick={() => { if (onArchiveSession !== undefined) void perform(onArchiveSession) }}
                >{sessionArchived ? t('archived') : t('archive')}</Button>
              </div>
            </section>
          ) : task.status === 'cancelled' ? (
            <section className={css.propertySection}>
              <h2>{t('disposition')}</h2>
              <div className={css.taskDispositionActions}>
                <Button
                  className={css.deleteTaskButton}
                  size="sm"
                  variant="outline"
                  icon={<Trash2 size={13} />}
                  disabled={busy}
                  onClick={() => { setDeleteAcknowledged(false); setDeleteOpen(true) }}
                >{t('deleteTask')}</Button>
              </div>
            </section>
          ) : null}

          <section className={css.propertySection}>
            <h2>Labels</h2>
            {editing ? <FactoryLabelSelect selected={labels} options={labelOptions} onChange={setLabels} /> : <div className={css.propertyLabels}>{task.labels.length === 0 ? <span className={css.propertyEmpty}>No labels</span> : task.labels.map(label => <TaskLabel label={label} key={label} />)}</div>}
          </section>

          <section className={css.propertySection}>
            <div className={css.propertySectionHeader}><h2>{t('project')}</h2>{project === undefined ? null : <Button size="sm" variant="ghost" icon={<Settings size={13} />} onClick={() => { onOpenSettings(project.mainPath) }}>Settings</Button>}</div>
            <div className={css.propertyRow}><span className={css.propertyIcon}><GitBranch size={15} /></span><span>{project?.title ?? '—'}</span></div>
          </section>

          <section className={css.propertySection}>
            <h2>{t('dependencies')}</h2>
            <div className={css.dependencyGraph}>
              <div><small>Blocked by</small>{dependencies.length === 0 ? <span className={css.graphEmpty}>No prerequisites</span> : dependencies.map(item => <span className={css.graphNode} key={item.id}><span className={css.miniStatus} data-status={item.status} />{item.identifier} · {item.title}</span>)}</div>
              <div className={css.graphCurrent}><small>Current</small><strong>{task.identifier} · {task.title}</strong></div>
              <div><small>Unlocks</small>{dependents.length === 0 ? <span className={css.graphEmpty}>No dependents</span> : dependents.map(item => <span className={css.graphNode} key={item.id}><span className={css.miniStatus} data-status={item.status} />{item.identifier} · {item.title}</span>)}</div>
            </div>
            <div className={css.inlineForm}>
              <FactorySelectMenu value={dependency || undefined} items={candidates.map(candidate => ({ id: candidate.id, label: `${candidate.identifier} · ${candidate.title}`, icon: <span className={css.miniStatus} data-status={candidate.status} /> }))} placeholder="Add dependency…" ariaLabel="Add dependency" search={{ placeholder: 'Search tasks…', emptyLabel: 'No tasks match your search.', ariaLabel: 'Search task dependencies' }} onSelect={setDependency} />
              <Button size="sm" variant="outline" disabled={busy || dependency === ''} onClick={() => { void perform(async () => { await onConnect({ taskId: task.id, dependsOnTaskId: dependency as FactoryTask['id'], expectedRevision: snapshot.revision }); setDependency('') }) }}>Add</Button>
            </div>
          </section>

          {emerging.length === 0 ? null : <section className={css.propertySection}><h2>{t('attach')}</h2><div className={css.inlineForm}><FactorySelectMenu value={agent || undefined} items={emerging.map(item => ({ id: item.sessionId, label: item.title ?? item.sessionId, icon: <Bot size={13} /> }))} placeholder={t('emerging')} ariaLabel={t('emerging')} onSelect={setAgent} /><Button size="sm" variant="outline" disabled={busy || agent === ''} onClick={() => { void perform(async () => { await onAttach({ taskId: task.id, sessionId: agent, expectedRevision: snapshot.revision }); setAgent('') }) }}>{t('attach')}</Button></div></section>}
        </aside>
      </div>
    </div>
  )
}
