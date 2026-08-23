import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Check, Circle, CircleCheck, CircleDashed, CircleX, Clock3, Diamond, LoaderCircle, Menu, Pause, Square, Triangle, TriangleAlert } from '@monotykamary/dsh-client-ui-primitives'
import {
  factoryRecurringLabel, orderTaskGraph, type FactoryPriority, type FactoryTask, type FactoryTaskStatus,
} from 'dsh-factory-protocol'
import css from './FactoryApp.module.css'

/** Linear-compatible priority options in menu order. */
export const FACTORY_PRIORITY_OPTIONS: ReadonlyArray<{ value: FactoryPriority; label: string }> = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
]

/** Return the user-facing Linear priority label. */
export function priorityLabel(priority: FactoryPriority): string {
  return FACTORY_PRIORITY_OPTIONS.find(option => option.value === priority)?.label ?? 'No priority'
}

/** Compact Linear-style priority glyph. */
export function PriorityIcon({ priority, size = 16 }: { priority: FactoryPriority; size?: number }) {
  const style = { '--priority-icon-size': `${String(size)}px` } as CSSProperties
  if (priority === 0) return <span className={css.priorityNone} style={style} aria-hidden="true">---</span>
  if (priority === 1) return <span className={css.priorityUrgent} style={style} aria-hidden="true">!</span>
  const activeBars = priority === 2 ? 3 : priority === 3 ? 2 : 1
  return (
    <span className={css.priorityBars} style={style} aria-hidden="true">
      {[0, 1, 2].map(index => <i key={index} data-active={index < activeBars || undefined} />)}
    </span>
  )
}

/** Row-level priority selector with current task counts. */
export function PriorityPicker({ priority, counts, disabled = false, onChange }: {
  priority: FactoryPriority
  counts: ReadonlyMap<FactoryPriority, number>
  disabled?: boolean
  onChange: (priority: FactoryPriority) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const label = priorityLabel(priority)
  return (
    <Menu
      open={open}
      portal
      compact
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        const next = Number(id) as FactoryPriority
        if (next === priority) return
        setBusy(true)
        void onChange(next).finally(() => { setBusy(false) })
      }}
      items={FACTORY_PRIORITY_OPTIONS.map(option => ({
        id: String(option.value),
        icon: <PriorityIcon priority={option.value} />,
        label: <span className={css.priorityMenuLabel} data-selected={option.value === priority || undefined}><span>{option.label}</span><i>{option.value === priority ? <Check size={14} /> : null}</i><small>{counts.get(option.value) ?? 0}</small></span>,
      }))}
      anchor={(
        <button
          type="button"
          className={css.priorityTrigger}
          disabled={disabled || busy}
          aria-label={`Set priority: ${label}`}
          title={disabled ? `${label} · unavailable while running` : label}
          onClick={(event) => { event.stopPropagation(); setOpen(value => !value) }}
          onKeyDown={(event) => { event.stopPropagation() }}
        >
          <PriorityIcon priority={priority} size={17} />
        </button>
      )}
    />
  )
}

/** Icon-only priority selector for task drafts. */
export function DraftPriorityPicker({ priority, onChange }: { priority: FactoryPriority; onChange: (priority: FactoryPriority) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      portal
      compact
      selectedId={String(priority)}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => { setOpen(false); onChange(Number(id) as FactoryPriority) }}
      items={FACTORY_PRIORITY_OPTIONS.map(option => ({ id: String(option.value), icon: <PriorityIcon priority={option.value} />, label: option.label }))}
      anchor={(
        <button type="button" className={css.priorityTrigger} aria-label={`Priority: ${priorityLabel(priority)}`} title={priorityLabel(priority)} onClick={() => { setOpen(value => !value) }}>
          <PriorityIcon priority={priority} size={17} />
        </button>
      )}
    />
  )
}

interface FactoryStatusOption {
  value: FactoryTaskStatus
  label: string
  statuses: readonly FactoryTaskStatus[]
}

/** Factory lifecycle groups in a Linear-style menu order. */
export const FACTORY_STATUS_OPTIONS: readonly FactoryStatusOption[] = [
  { value: 'running', label: 'In progress', statuses: ['dispatching', 'running'] },
  { value: 'waiting', label: 'Waiting', statuses: ['waiting'] },
  { value: 'scheduled', label: 'Scheduled', statuses: ['scheduled'] },
  { value: 'paused', label: 'Paused', statuses: ['paused'] },
  { value: 'queued', label: 'Todo', statuses: ['queued'] },
  { value: 'draft', label: 'Backlog', statuses: ['draft'] },
  { value: 'succeeded', label: 'Done', statuses: ['succeeded'] },
  { value: 'failed', label: 'Failed', statuses: ['failed'] },
  { value: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
]

/** Collapse transient dispatch into the visible in-progress lifecycle group. */
export function visibleTaskStatus(status: FactoryTaskStatus): FactoryTaskStatus {
  return status === 'dispatching' ? 'running' : status
}

/** Human-readable grouped lifecycle label. */
export function statusLabel(status: FactoryTaskStatus): string {
  const visible = visibleTaskStatus(status)
  return FACTORY_STATUS_OPTIONS.find(option => option.value === visible)?.label ?? status
}

/** Compact color-coded lifecycle glyph shared by rows and counted status menus. */
export function TaskStatusIcon({ status, size = 15 }: { status: FactoryTaskStatus; size?: number }) {
  const icon = status === 'succeeded'
    ? <CircleCheck size={size} />
    : status === 'failed' || status === 'cancelled'
      ? <TriangleAlert size={size} />
      : status === 'running' || status === 'dispatching'
        ? <LoaderCircle size={size} />
        : status === 'scheduled'
          ? <Clock3 size={size} />
        : status === 'waiting' || status === 'paused'
          ? <Pause size={size} />
          : <CircleDashed size={size} />
  return <span className={css.statusIcon} data-status={status}>{icon}</span>
}

/** Return lifecycle targets backed by existing Factory actions for one task. */
export function allowedTaskStatusTargets(task: FactoryTask): ReadonlySet<FactoryTaskStatus> {
  const allowed = new Set<FactoryTaskStatus>()
  if (task.status === 'draft' || task.status === 'failed' || task.status === 'cancelled') allowed.add('queued')
  if (task.status === 'scheduled') { allowed.add('queued'); allowed.add('paused') }
  if (task.status === 'paused') allowed.add(task.automation?.trigger.kind === 'recurring' ? 'scheduled' : 'queued')
  if (task.status === 'queued' || task.status === 'waiting') allowed.add('paused')
  if (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'cancelled') allowed.add('cancelled')
  return allowed
}

/** Counted lifecycle selector exposing only transitions owned by Factory actions. */
export function StatusPicker({ status, counts, allowed, onChange }: {
  status: FactoryTaskStatus
  counts: ReadonlyMap<FactoryTaskStatus, number>
  allowed: ReadonlySet<FactoryTaskStatus>
  onChange: (status: FactoryTaskStatus) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const visible = visibleTaskStatus(status)
  return (
    <Menu
      open={open}
      portal
      compact
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        const next = id as FactoryTaskStatus
        if (next === visible) return
        setBusy(true)
        void onChange(next).finally(() => { setBusy(false) })
      }}
      items={FACTORY_STATUS_OPTIONS.map(option => ({
        id: option.value,
        icon: <TaskStatusIcon status={option.value} />,
        disabled: !allowed.has(option.value) && option.value !== visible,
        label: <span className={css.statusMenuLabel} data-selected={option.value === visible || undefined}><span>{option.label}</span><i>{option.value === visible ? <Check size={14} /> : null}</i><small>{option.statuses.reduce((total, value) => total + (counts.get(value) ?? 0), 0)}</small></span>,
      }))}
      anchor={(
        <button
          type="button"
          className={`${css.statusTrigger} ${css.taskStatus}`}
          data-status={status}
          disabled={busy}
          aria-label={`Set status: ${statusLabel(status)}`}
          title={`${statusLabel(status)} · ${String(counts.get(status) ?? 0)} tasks`}
          onClick={() => { setOpen(value => !value) }}
        >
          <TaskStatusIcon status={status} />
        </button>
      )}
    />
  )
}

/** Deterministic semantic tone for one task label. */
export function labelTone(label: string): string {
  let hash = 0
  for (const character of label) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return String(hash % 5)
}

function dependencySignature(task: FactoryTask, memberIds: ReadonlySet<FactoryTask['id']>): string {
  return task.dependencyIds.filter(id => memberIds.has(id)).map(String).toSorted().join('|')
}

/** Linear-style neutral label pill with one deterministic semantic dot. */
export function TaskLabel({ label }: { label: string }) {
  return <span className={css.taskLabel}><i data-tone={labelTone(label)} />{label}</span>
}

type QueueGraphKind = 'independent' | 'root' | 'parallel' | 'join' | 'sequential' | 'finalizer'
type QueueNodeState = 'pending' | 'running' | 'succeeded' | 'failed'

interface QueueRailLink {
  from: number
  to: number
}

interface QueueGraphPresentation {
  kind: QueueGraphKind
  label: string
  detail: string
  railBefore: readonly number[]
  railAfter: readonly number[]
  links: readonly QueueRailLink[]
  nodeLane: number
  maxLane: number
  start: boolean
  state: QueueNodeState
}

interface BranchRegion {
  start: number
  end: number
  members: ReadonlySet<FactoryTask['id']>
  lane: number
  closed: boolean
}

function queueBranchRegions(ordered: readonly FactoryTask[], memberIds: ReadonlySet<FactoryTask['id']>): BranchRegion[] {
  const children = new Map<FactoryTask['id'], FactoryTask[]>()
  for (const task of ordered) {
    for (const dependencyId of task.dependencyIds) {
      if (!memberIds.has(dependencyId)) continue
      const rows = children.get(dependencyId) ?? []
      rows.push(task)
      children.set(dependencyId, rows)
    }
  }
  const descendantsById = new Map<FactoryTask['id'], ReadonlySet<FactoryTask['id']>>()
  const descendants = (id: FactoryTask['id'], trail = new Set<FactoryTask['id']>()): ReadonlySet<FactoryTask['id']> => {
    const cached = descendantsById.get(id)
    if (cached !== undefined) return cached
    if (trail.has(id)) return new Set()
    const nextTrail = new Set(trail).add(id)
    const found = new Set<FactoryTask['id']>()
    for (const child of children.get(id) ?? []) {
      found.add(child.id)
      for (const nested of descendants(child.id, nextTrail)) found.add(nested)
    }
    descendantsById.set(id, found)
    return found
  }
  const groups = new Map<string, FactoryTask[]>()
  for (const task of ordered) {
    const signature = dependencySignature(task, memberIds)
    const group = groups.get(signature) ?? []
    group.push(task)
    groups.set(signature, group)
  }
  const positions = new Map(ordered.map((task, index) => [task.id, index]))
  const regions: BranchRegion[] = []
  for (const siblings of groups.values()) {
    if (siblings.length < 2) continue
    const start = Math.min(...siblings.map(sibling => positions.get(sibling.id) ?? 0))
    const reaches = (source: FactoryTask, target: FactoryTask): boolean => source.id === target.id || descendants(source.id).has(target.id)
    const commonJoin = ordered.slice(start + 1).find(candidate => candidate.dependencyIds.length > 1 && siblings.every(sibling => reaches(sibling, candidate)))
    const reachable = ordered.filter(candidate => siblings.some(sibling => reaches(sibling, candidate)))
    const closed = commonJoin !== undefined
    const end = commonJoin === undefined
      ? Math.max(...reachable.map(candidate => positions.get(candidate.id) ?? start))
      : positions.get(commonJoin.id) ?? start
    const members = new Set(reachable.filter(candidate => {
      const candidatePosition = positions.get(candidate.id) ?? start
      return candidatePosition < end || (!closed && candidatePosition === end)
    }).map(candidate => candidate.id))
    regions.push({ start, end, members, lane: 0, closed })
  }
  const assigned: BranchRegion[] = []
  for (const region of regions.toSorted((left, right) => left.start - right.start || right.end - left.end)) {
    const occupied = new Set(assigned.filter(other => other.start <= region.end && region.start <= other.end).map(other => other.lane))
    let lane = 1
    while (occupied.has(lane)) lane += 1
    assigned.push({ ...region, lane })
  }
  return assigned
}

function queueNodeState(status: FactoryTaskStatus): QueueNodeState {
  if (status === 'running' || status === 'dispatching') return 'running'
  if (status === 'succeeded') return 'succeeded'
  if (status === 'failed') return 'failed'
  return 'pending'
}

/** Derive queue copy and row-local rail segments from actual task dependencies. */
export function queueGraphPresentation(task: FactoryTask, tasks: readonly FactoryTask[]): QueueGraphPresentation {
  if (task.flowId === undefined) {
    return { kind: 'independent', label: 'Independent', detail: 'No queue links', railBefore: [], railAfter: [], links: [], nodeLane: 0, maxLane: 0, start: false, state: queueNodeState(task.status) }
  }
  const ordered = orderTaskGraph(tasks)
  const memberIds = new Set(tasks.map(candidate => candidate.id))
  const parents = task.dependencyIds.flatMap(id => tasks.find(candidate => candidate.id === id) ?? [])
  const signature = dependencySignature(task, memberIds)
  const siblings = ordered.filter(candidate => dependencySignature(candidate, memberIds) === signature)
  const siblingIndex = siblings.findIndex(candidate => candidate.id === task.id)
  let kind: QueueGraphKind
  let label: string
  let detail: string
  if (parents.length === 0 && siblings.length > 1) {
    kind = 'parallel'; label = 'Parallel root'; detail = `${String(siblingIndex + 1)} of ${String(siblings.length)}`
  } else if (parents.length === 0) {
    kind = 'root'; label = 'Flow start'; detail = 'No prerequisites'
  } else if (parents.length > 1) {
    kind = 'join'; label = 'Join'; detail = `${String(parents.length)} prerequisites`
  } else if (siblings.length > 1) {
    kind = 'parallel'; label = 'Parallel'; detail = `${String(siblingIndex + 1)} of ${String(siblings.length)}`
  } else if (task.finalizer) {
    kind = 'finalizer'; label = 'Finalizer'; detail = `After ${parents[0]?.identifier ?? 'flow'}`
  } else {
    kind = 'sequential'; label = 'Sequential'; detail = `After ${parents[0]?.identifier ?? 'flow'}`
  }
  if (task.automation !== undefined) {
    const timing = task.automation.trigger.kind === 'manual'
      ? 'manual'
      : task.automation.trigger.kind === 'delay'
        ? `wait ${String(task.automation.trigger.delayMinutes)}m`
        : task.automation.trigger.kind === 'schedule' ? 'one time' : factoryRecurringLabel(task.automation.trigger.schedule)
    detail = `${detail} · ${timing}`
  }
  const position = ordered.findIndex(candidate => candidate.id === task.id)
  const regions = queueBranchRegions(ordered, memberIds)
  const containing = regions.filter(region => region.members.has(task.id))
  const nodeLane = Math.max(0, ...containing.map(region => region.lane))
  const railBefore = [
    ...(position > 0 ? [0] : []),
    ...regions.filter(region => position > region.start && position <= region.end).map(region => region.lane),
  ].toSorted((left, right) => left - right)
  const railAfter = [
    ...(position < ordered.length - 1 ? [0] : []),
    ...regions.filter(region => position >= region.start && position < region.end).map(region => region.lane),
  ].toSorted((left, right) => left - right)
  const links = new Map<string, QueueRailLink>()
  for (const region of regions.filter(candidate => candidate.start === position).toSorted((left, right) => left.lane - right.lane)) {
    const parentLane = Math.max(0, ...containing.filter(candidate => candidate.lane < region.lane).map(candidate => candidate.lane))
    links.set(`${String(parentLane)}:${String(region.lane)}`, { from: parentLane, to: region.lane })
  }
  for (const region of regions.filter(candidate => candidate.closed && candidate.end === position).toSorted((left, right) => right.lane - left.lane)) {
    links.set(`${String(region.lane)}:${String(nodeLane)}`, { from: region.lane, to: nodeLane })
  }
  return {
    kind, label, detail, railBefore, railAfter, links: [...links.values()], nodeLane,
    maxLane: Math.max(0, ...regions.map(region => region.lane)), start: parents.length === 0, state: queueNodeState(task.status),
  }
}

/** Compact dependency-driven relationship cell for one topologically ordered task row. */
export function QueueGraphCell({ task, tasks }: {
  task: FactoryTask
  tasks: readonly FactoryTask[]
}) {
  const graph = queueGraphPresentation(task, tasks)
  const graphStyle = { '--queue-glyph-width': `${String(16 + graph.maxLane * 14)}px` } as CSSProperties
  const railStyle = (lane: number): CSSProperties => ({ '--queue-x': `${String(8 + lane * 14)}px` } as CSSProperties)
  const stateIcon = graph.state === 'running'
    ? <LoaderCircle size={13} />
    : graph.state === 'succeeded'
      ? <CircleCheck size={13} />
      : graph.state === 'failed'
        ? <CircleX size={13} />
        : graph.kind === 'parallel'
          ? <Triangle size={10} />
          : graph.kind === 'join'
            ? <Diamond size={10} />
            : graph.kind === 'finalizer'
              ? <Square size={10} />
              : <Circle size={10} />
  return (
    <span className={css.queueGraph} style={graphStyle} title={`${graph.label} · ${graph.detail} · ${statusLabel(task.status)}`}>
      <span className={css.queueGlyph} data-kind={graph.kind} data-state={graph.state} data-start={graph.start || undefined} data-node-lane={String(graph.nodeLane)}>
        {graph.railBefore.map(lane => <span key={`before:${String(lane)}`} className={css.queueRailBefore} style={railStyle(lane)} data-segment="rail-before" data-lane={lane} />)}
        {graph.railAfter.map(lane => <span key={`after:${String(lane)}`} className={css.queueRailAfter} style={railStyle(lane)} data-segment="rail-after" data-lane={lane} />)}
        {graph.links.map(link => {
          const start = Math.min(link.from, link.to)
          const style = { '--queue-link-x': `${String(8 + start * 14)}px`, '--queue-link-width': `${String(Math.abs(link.to - link.from) * 14)}px` } as CSSProperties
          return <span key={`${String(link.from)}:${String(link.to)}`} className={css.queueRailLink} style={style} data-segment="rail-link" data-from={link.from} data-to={link.to} />
        })}
        <span className={css.queueNode} style={{ left: `${String(2 + graph.nodeLane * 14)}px` }} data-segment="node" data-lane={graph.nodeLane} data-state={graph.state}>{stateIcon}</span>
      </span>
      <span className={css.queueCopy}><strong>{graph.label}</strong><small>{graph.detail}</small></span>
    </span>
  )
}
