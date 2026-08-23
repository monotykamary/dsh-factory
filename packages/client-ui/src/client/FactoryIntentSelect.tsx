import { useState, useSyncExternalStore } from 'react'
import {
  ChevronDown, ChevronLeft, ChevronRight, Clock3, GitBranch, ListTodo, LoaderCircle, Menu, Play, Plus,
} from '@monotykamary/dsh-client-ui-primitives'
import type { MenuEntry } from '@monotykamary/dsh-client-ui-primitives'
import type { PropsLocale } from '@monotykamary/dsh-client-ui-slots'
import type { InputZone } from '@monotykamary/dsh-client-ui-conversation/client'
import type { FactoryFlowIntakePlacement } from 'dsh-factory-protocol'
import type { FactoryIntentController, FactorySessionIntent } from './factory-intake.ts'
import css from './FactoryIntentSelect.module.css'

/** Injected controller for one session-scoped intent selector. */
export interface FactoryIntentSelectInjected {
  readonly controller: FactoryIntentController
}

type Pane = 'root' | 'task' | 'flow' | 'placement'

function intentIcon(intent: FactorySessionIntent) {
  return intent.kind === 'task' ? <ListTodo size={15} /> : <GitBranch size={15} />
}

/** New Session selector for Emerging work or flow intake. */
export function FactoryIntentSelect({ controller, session, input, t }: FactoryIntentSelectInjected & InputZone & PropsLocale<'factory'>) {
  const state = useSyncExternalStore(fn => controller.store.subscribe(fn), () => controller.store.getSnapshot())
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [flowId, setFlowId] = useState<string>()
  if (!session.blank || session.subagent !== null) return null
  const locked = input.phase === 'adjudicating' || input.phase === 'submitting'
  const selectedFlow = state.flows.find(flow => flow.id === flowId)

  const close = (): void => { setOpen(false); setPane('root'); setFlowId(undefined) }
  const chooseIntent = (intent: FactorySessionIntent): void => { controller.select(intent); close() }
  const placement = (value: FactoryFlowIntakePlacement): void => {
    if (selectedFlow !== undefined) chooseIntent({ kind: 'flow', flowId: selectedFlow.id, flowTitle: selectedFlow.title, placement: value })
  }

  let items: MenuEntry[]
  let selectedId: string | undefined
  if (pane === 'root') {
    selectedId = state.intent.kind === 'task' ? 'task' : 'flow'
    items = [
      { id: 'task', icon: <ListTodo size={15} />, label: <span className={css.option}><strong>{t('intake.task')}</strong><small>{t('intake.taskDetail')}</small></span>, trailing: <ChevronRight size={14} /> },
      { id: 'flow', icon: <GitBranch size={15} />, label: <span className={css.option}><strong>{t('intake.flow')}</strong><small>{t('intake.flowDetail')}</small></span>, trailing: <ChevronRight size={14} /> },
    ]
  } else if (pane === 'task') {
    selectedId = state.intent.kind === 'task' ? state.intent.run : undefined
    items = [
      { id: 'back', icon: <ChevronLeft size={15} />, label: t('intake.back') },
      { type: 'label', id: 'task-label', text: t('intake.task') },
      { id: 'now', icon: <Play size={15} />, label: <span className={css.option}><strong>{t('intake.runNow')}</strong><small>{t('intake.runNowDetail')}</small></span> },
      { id: 'later', icon: <Clock3 size={15} />, label: <span className={css.option}><strong>{t('intake.runLater')}</strong><small>{t('intake.runLaterDetail')}</small></span> },
    ]
  } else if (pane === 'flow') {
    selectedId = state.intent.kind === 'new-flow' ? 'new-flow' : state.intent.kind === 'flow' ? `flow:${state.intent.flowId}` : undefined
    items = [
      { id: 'back', icon: <ChevronLeft size={15} />, label: t('intake.back') },
      { type: 'separator', id: 'flow-separator' },
      { id: 'new-flow', icon: <Plus size={15} />, label: <span className={css.option}><strong>{t('intake.newFlow')}</strong><small>{t('intake.newFlowDetail')}</small></span> },
      ...state.flows.map(flow => ({
        id: `flow:${flow.id}`, icon: <GitBranch size={15} />,
        label: <span className={css.option}><strong>{flow.title}</strong><small>{flow.status}</small></span>,
        trailing: <ChevronRight size={14} />,
      })),
      ...(state.loading ? [{ id: 'loading', disabled: true, icon: <LoaderCircle size={15} />, label: t('intake.loading') } satisfies MenuEntry] : []),
      ...(state.error === undefined ? [] : [{ id: 'error', disabled: true, label: state.error } satisfies MenuEntry]),
    ]
  } else {
    selectedId = state.intent.kind === 'flow' && state.intent.flowId === selectedFlow?.id ? state.intent.placement : undefined
    items = [
      { id: 'back', icon: <ChevronLeft size={15} />, label: t('intake.back') },
      { type: 'label', id: 'placement-label', text: selectedFlow?.title ?? t('intake.flow') },
      { id: 'parallel', label: <span className={css.option}><strong>{t('intake.parallel')}</strong><small>{t('intake.parallelDetail')}</small></span> },
      { id: 'sequential', label: <span className={css.option}><strong>{t('intake.sequential')}</strong><small>{t('intake.sequentialDetail')}</small></span> },
      { id: 'finalizer', label: <span className={css.option}><strong>{t('intake.finalizer')}</strong><small>{t('intake.finalizerDetail')}</small></span> },
    ]
  }

  const select = (id: string): void => {
    if (pane === 'root') {
      if (id === 'task') setPane('task')
      else { setPane('flow'); void controller.load() }
      return
    }
    if (id === 'back') { setPane(pane === 'placement' ? 'flow' : 'root'); setFlowId(undefined); return }
    if (pane === 'task') {
      if (id === 'now' || id === 'later') chooseIntent({ kind: 'task', run: id })
      return
    }
    if (pane === 'flow') {
      if (id === 'new-flow') chooseIntent({ kind: 'new-flow' })
      else if (id.startsWith('flow:')) { setFlowId(id.slice(5)); setPane('placement') }
      return
    }
    if (id === 'parallel' || id === 'sequential' || id === 'finalizer') placement(id)
  }

  const label = state.intent.kind === 'task'
    ? state.intent.run === 'now' ? t('intake.task') : `${t('intake.task')} · ${t('intake.runLater')}`
    : state.intent.kind === 'new-flow'
      ? t('intake.newFlow')
      : `${state.intent.flowTitle} · ${t(state.intent.placement === 'parallel' ? 'intake.parallel' : state.intent.placement === 'sequential' ? 'intake.sequential' : 'intake.finalizer')}`
  return (
    <Menu
      open={open}
      portal
      side="top"
      items={items}
      selectedId={selectedId}
      onSelect={select}
      onClose={close}
      anchor={(
        <button
          type="button"
          className={css.trigger}
          aria-label={t('intake.aria', { intent: label })}
          aria-haspopup="menu"
          aria-expanded={open}
          title={label}
          disabled={locked}
          onClick={() => { if (open) close(); else { setPane('root'); setOpen(true) } }}
        >
          <span className={css.icon} aria-hidden>{intentIcon(state.intent)}</span>
          <span className={css.label}>{label}</span>
          <ChevronDown size={14} className={`${css.chevron} ${open ? css.chevronOpen : ''}`} />
        </button>
      )}
    />
  )
}
