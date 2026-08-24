import { useMemo, useState } from 'react'
import {
  Button, Check, ChevronLeft, ChevronRight, CircleCheck, Clock3, ListTodo, MarkdownText, TriangleAlert,
} from '@monotykamary/dsh-client-ui-primitives'
import { ProducedFilesCard, type DeliverableChange } from '@monotykamary/dsh-client-ui-deliverables/client'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import { factoryRecurringLabel, type FactoryRun, type FactorySnapshot, type FactoryTask } from 'dsh-factory-protocol'
import { FactoryArtifactMedia } from './FactoryArtifactMedia.tsx'
import type { FactoryRemote } from './factory-client.ts'
import css from './FactoryApp.module.css'

type TriageFilter = 'all' | 'unread' | 'failed'

interface Props {
  snapshot: FactorySnapshot
  api: Pick<FactoryRemote, 'artifactMedia' | 'artifactMediaData'>
  t: TranslateNS<'factory'>
  onOpenTask: (taskId: FactoryTask['id']) => void
  onReview: (runIds: FactoryRun['id'][]) => Promise<void>
}

function runChanges(run: FactoryRun): DeliverableChange[] {
  return (run.output?.mutations ?? []).map(mutation => ({
    seq: mutation.commitOrder, commitOrder: mutation.commitOrder, turn: 0,
    callId: `factory:${String(run.id)}:${String(mutation.commitOrder)}`,
    title: `${mutation.operation} ${mutation.path}`, diffs: mutation.diffs,
  }))
}

function completedAt(run: FactoryRun): string {
  return run.finishedAt ?? run.updatedAt
}

/** Review inbox for every terminal Factory task run. */
export function FactoryTriage({ snapshot, api, t, onOpenTask, onReview }: Props) {
  const tasks = useMemo(() => new Map(snapshot.document.tasks.map(task => [task.id, task])), [snapshot.document.tasks])
  const runs = useMemo(() => snapshot.document.runs
    .filter(run => {
      return tasks.has(run.taskId) && ['succeeded', 'failed', 'cancelled'].includes(run.status)
    })
    .toSorted((left, right) => completedAt(right).localeCompare(completedAt(left))), [snapshot.document.runs, tasks])
  const [filter, setFilter] = useState<TriageFilter>('all')
  const [selectedId, setSelectedId] = useState<FactoryRun['id']>()
  const visible = runs.filter(run => filter === 'all' || (filter === 'unread' ? run.reviewedAt === undefined : run.status === 'failed'))
  const selected = visible.find(run => run.id === selectedId) ?? visible[0]
  const selectedTask = selected === undefined ? undefined : tasks.get(selected.taskId)
  const unread = runs.filter(run => run.reviewedAt === undefined)
  const markReviewed = async (runIds: FactoryRun['id'][]): Promise<void> => {
    const pending = runIds.filter(id => runs.find(run => run.id === id)?.reviewedAt === undefined)
    if (pending.length > 0) await onReview(pending)
  }

  if (runs.length === 0) return <div className={css.emptyState}><ListTodo size={30} /><span>Completed task results will appear here.</span></div>
  return (
    <div className={css.triagePage} data-detail-open={selectedId !== undefined && selected !== undefined ? true : undefined} data-testid="factory-triage">
      <header className={css.triageToolbar}>
        <div><h2>Triage</h2><p>Review completed regular tasks and recurring occurrences in one inbox.</p></div>
        <Button variant="outline" size="sm" icon={<Check size={14} />} disabled={unread.length === 0} onClick={() => { void markReviewed(unread.map(run => run.id)) }}>Mark all read</Button>
      </header>
      <div className={css.triageFilters}>
        {(['all', 'unread', 'failed'] as const).map(value => <button type="button" data-active={filter === value || undefined} key={value} onClick={() => { setFilter(value); setSelectedId(undefined) }}>{value === 'all' ? `All ${String(runs.length)}` : value === 'unread' ? `Unread ${String(unread.length)}` : `Failed ${String(runs.filter(run => run.status === 'failed').length)}`}</button>)}
      </div>
      <div className={css.triageColumns}>
        <div className={css.triageList}>
          {visible.length === 0 ? <div className={css.triageEmpty}>No results match this filter.</div> : visible.map(run => {
            const task = tasks.get(run.taskId)
            if (task === undefined) return null
            return (
              <button type="button" className={css.triageRow} data-selected={selected?.id === run.id || undefined} data-unread={run.reviewedAt === undefined || undefined} key={run.id} onClick={() => { setSelectedId(run.id); void markReviewed([run.id]) }}>
                <span className={css.triageStatus} data-status={run.status}>{run.status === 'succeeded' ? <CircleCheck size={15} /> : <TriangleAlert size={15} />}</span>
                <span className={css.triageIdentity}><strong>{task.title}</strong><small>{task.identifier} · Run {String(run.attempt)} · {run.schedule === undefined ? run.origin === 'observed' ? 'Observed Session' : 'Regular task' : factoryRecurringLabel(run.schedule)}</small><em>{run.output?.summary ?? run.failure ?? run.status}</em></span>
                <time>{new Date(completedAt(run)).toLocaleString()}</time>
                <ChevronRight size={13} />
              </button>
            )
          })}
        </div>
        {selected === undefined || selectedTask === undefined ? null : (
          <aside className={css.triageDetail}>
            <div className={css.triageMobileBack}><Button variant="ghost" size="sm" icon={<ChevronLeft size={14} />} onClick={() => { setSelectedId(undefined) }}>Back to results</Button></div>
            <header><div><span className={css.triageStatus} data-status={selected.status}>{selected.status === 'succeeded' ? <CircleCheck size={16} /> : <TriangleAlert size={16} />}</span><div><h3>{selectedTask.title}</h3><p>{selectedTask.identifier} · Run {String(selected.attempt)}</p></div></div><Button variant="ghost" size="sm" onClick={() => { onOpenTask(selectedTask.id) }}>Open task</Button></header>
            <dl>
              <div><dt>Result</dt><dd>{selected.status}</dd></div>
              <div><dt>Finished</dt><dd>{new Date(completedAt(selected)).toLocaleString()}</dd></div>
              <div><dt>Next run</dt><dd>{selected.schedule === undefined ? '—' : selectedTask.automation?.nextRunAt === undefined ? 'Paused' : new Date(selectedTask.automation.nextRunAt).toLocaleString()}</dd></div>
              <div><dt>Schedule</dt><dd>{selected.schedule === undefined ? selected.origin === 'observed' ? 'Observed Session' : 'One time' : factoryRecurringLabel(selected.schedule)}</dd></div>
            </dl>
            <section><div className={css.sectionTitle}><Clock3 size={15} /><h2>Run result</h2></div><MarkdownText text={[selected.output?.summary ?? selected.failure ?? '', selected.output?.details].filter(Boolean).join('\n\n')} /></section>
            <FactoryArtifactMedia api={api} taskId={selectedTask.id} runId={selected.id} refreshToken={String(snapshot.revision)} surface="triage" />
            {selected.output?.artifacts.length ? <section><h4>Artifacts</h4><div className={css.artifactList}>{selected.output.artifacts.map(value => <code key={value}>{value}</code>)}</div></section> : null}
            {selected.output?.mutations.length ? <ProducedFilesCard changes={runChanges(selected)} labels={{ changed: count => t(count === 1 ? 'changes.changedOne' : 'changes.changed', { count: String(count) }), viewFileDiff: path => t('changes.viewFileDiff', { name: path }), expandFolders: t('changes.expandFolders'), collapseFolders: t('changes.collapseFolders'), viewDiff: t('changes.viewDiff') }} /> : null}
          </aside>
        )}
      </div>
    </div>
  )
}
