import type {
  FactoryDocument, FactoryFlowStatus, FactoryGraphIssue, FactoryPriority, FactoryTask, FactoryTaskId, FactoryTaskStatus,
} from './types.ts'

const TERMINAL = new Set<FactoryTaskStatus>(['succeeded', 'failed', 'cancelled'])

/** Return graph violations without mutating the document. */
export function validateTaskGraph(document: FactoryDocument): FactoryGraphIssue[] {
  const issues: FactoryGraphIssue[] = []
  const tasks = new Map(document.tasks.map(task => [task.id, task]))
  const flows = new Map(document.flows.map(flow => [flow.id, flow]))
  const inboxProjects = new Set<string>()
  const memberships = new Map<FactoryTaskId, string>()
  for (const flow of document.flows) {
    if (flow.kind === 'inbox') {
      if (inboxProjects.has(flow.projectId)) issues.push({ code: 'duplicate-inbox', message: `project ${flow.projectId} has multiple emerging-work flows` })
      inboxProjects.add(flow.projectId)
    }
    for (const taskId of flow.taskIds) {
      const prior = memberships.get(taskId)
      if (prior !== undefined && prior !== flow.id) issues.push({ code: 'flow-membership', taskId, message: `task ${taskId} belongs to multiple flows` })
      memberships.set(taskId, flow.id)
      const task = tasks.get(taskId)
      if (task === undefined || task.flowId !== flow.id) issues.push({ code: 'flow-membership', taskId, message: `flow ${flow.id} disagrees with task ${taskId} ownership` })
    }
  }
  for (const task of document.tasks) {
    if (task.flowId !== undefined && (!flows.has(task.flowId) || memberships.get(task.id) !== task.flowId)) {
      issues.push({ code: 'flow-membership', taskId: task.id, message: `${task.identifier} flow ownership is incomplete` })
    }

    for (const dependencyId of task.dependencyIds) {
      const dependency = tasks.get(dependencyId)
      if (dependency === undefined) {
        issues.push({ code: 'missing-dependency', taskId: task.id, message: `${task.identifier} depends on a missing task` })
      } else if (dependency.id === task.id) {
        issues.push({ code: 'self-dependency', taskId: task.id, message: `${task.identifier} depends on itself` })
      } else if (dependency.projectId !== task.projectId) {
        issues.push({ code: 'cross-project', taskId: task.id, message: `${task.identifier} crosses project checkout ownership` })
      } else if (dependency.finalizer && !task.finalizer) {
        issues.push({ code: 'finalizer-dependency', taskId: task.id, message: `${task.identifier} depends on a finalizer` })
      }
    }
  }

  const color = new Map<FactoryTaskId, 0 | 1 | 2>()
  const visit = (id: FactoryTaskId): void => {
    const state = color.get(id) ?? 0
    if (state === 2) return
    if (state === 1) {
      issues.push({ code: 'cycle', taskId: id, message: `dependency cycle reaches ${tasks.get(id)?.identifier ?? id}` })
      return
    }
    color.set(id, 1)
    for (const dependency of tasks.get(id)?.dependencyIds ?? []) if (tasks.has(dependency)) visit(dependency)
    color.set(id, 2)
  }
  for (const task of document.tasks) visit(task.id)
  return issues
}

/** Determine whether a queued task may claim its lane now. */
export function isTaskReady(task: FactoryTask, tasks: ReadonlyMap<FactoryTaskId, FactoryTask>, now: number = Date.now()): boolean {
  if (task.status !== 'queued') return false
  if (task.retryAt !== undefined && Date.parse(task.retryAt) > now) return false
  if (!task.finalizer) return task.dependencyIds.every(id => tasks.get(id)?.status === 'succeeded')
  const flowTasks = task.flowId === undefined ? [] : [...tasks.values()].filter(candidate => candidate.flowId === task.flowId && !candidate.finalizer)
  if (!flowTasks.every(candidate => TERMINAL.has(candidate.status))) return false
  if (task.finalizerPolicy === 'success' && !flowTasks.every(candidate => candidate.status === 'succeeded')) return false
  return task.dependencyIds.every(id => TERMINAL.has(tasks.get(id)?.status ?? 'draft'))
}

/** Return the scheduling rank for a Linear-compatible priority, placing no-priority work last. */
export function factoryPriorityRank(priority: FactoryPriority): number {
  return priority === 0 ? 5 : priority
}

function compareStableTasks(left: FactoryTask, right: FactoryTask): number {
  return left.createdAt.localeCompare(right.createdAt) || left.identifier.localeCompare(right.identifier, undefined, { numeric: true })
}

/** Stable scheduling order: Linear priority, creation time, then identifier. */
export function readyTasks(document: FactoryDocument, now: number = Date.now()): FactoryTask[] {
  const tasks = new Map(document.tasks.map(task => [task.id, task]))
  return document.tasks.filter(task => isTaskReady(task, tasks, now)).toSorted((left, right) =>
    factoryPriorityRank(left.priority) - factoryPriorityRank(right.priority) || compareStableTasks(left, right),
  )
}

/** Return task nodes in stable dependency-first order for graph presentation. */
export function orderTaskGraph(tasks: readonly FactoryTask[]): FactoryTask[] {
  const members = new Map(tasks.map(task => [task.id, task]))
  const remainingDependencies = new Map<FactoryTaskId, number>()
  const children = new Map<FactoryTaskId, FactoryTask[]>()
  for (const task of tasks) {
    const dependencies = [...new Set(task.dependencyIds.filter(id => members.has(id)))]
    remainingDependencies.set(task.id, dependencies.length)
    for (const dependency of dependencies) {
      const rows = children.get(dependency) ?? []
      rows.push(task)
      children.set(dependency, rows)
    }
  }

  let ready = tasks.filter(task => remainingDependencies.get(task.id) === 0).toSorted(compareStableTasks)
  const ordered: FactoryTask[] = []
  const seen = new Set<FactoryTaskId>()
  while (ready.length > 0) {
    const task = ready.shift()
    if (task === undefined || seen.has(task.id)) continue
    ordered.push(task)
    seen.add(task.id)
    for (const child of (children.get(task.id) ?? []).toSorted(compareStableTasks)) {
      const remaining = (remainingDependencies.get(child.id) ?? 1) - 1
      remainingDependencies.set(child.id, remaining)
      if (remaining === 0) {
        ready.push(child)
        ready = ready.toSorted(compareStableTasks)
      }
    }
  }
  return [...ordered, ...tasks.filter(task => !seen.has(task.id)).toSorted(compareStableTasks)]
}

/** Derive one flow status from its current task records. */
export function deriveFlowStatus(tasks: readonly FactoryTask[]): FactoryFlowStatus {
  if (tasks.every(task => task.status === 'draft')) return 'draft'
  const ordinary = tasks.filter(task => !task.finalizer)
  if (ordinary.some(task => task.status === 'failed')) return 'failed'
  if (ordinary.some(task => task.status === 'cancelled')) return 'cancelled'
  if (tasks.every(task => task.status === 'succeeded' || (task.finalizer && task.status === 'cancelled'))) return 'succeeded'
  if (tasks.some(task => task.status === 'waiting' || task.status === 'paused')) return 'waiting'
  if (tasks.some(task => ['dispatching', 'running'].includes(task.status))) return 'running'
  if (tasks.some(task => task.status === 'scheduled')) return 'scheduled'
  return 'queued'
}

/** Compute the serialized checkout lane key for a task with a resolved path. */
export function laneKey(task: FactoryTask, projectMainPath: string): string {
  if (task.lane.mode === 'current') return `path:${projectMainPath}`
  if (task.lane.mode === 'reuse') return `reuse:${task.lane.reuseTaskId ?? task.id}`
  return `isolated:${task.id}`
}
