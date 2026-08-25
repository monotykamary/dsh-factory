// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ConversationSnapshot } from '@monotykamary/dsh-client-runtime/client'
import {
  FactoryCommentId, FactoryFlowId, FactoryProjectId, FactoryTaskId, orderTaskGraph, type FactoryTask,
} from 'dsh-factory-protocol'
import { automationMode, automationSpec } from '../src/client/FactoryAutomationControls.tsx'
import { QueueGraphCell, queueGraphPresentation } from '../src/client/FactoryTaskVisuals.tsx'
import { factoryDiscussionItems } from '../src/client/FactoryTaskDiscussion.tsx'

const now = '2026-08-23T00:00:00.000Z'
const projectId = FactoryProjectId('project:one')
const flowId = FactoryFlowId('flow:one')

afterEach(cleanup)

function task(id: string, overrides: Partial<FactoryTask> = {}): FactoryTask {
  return {
    id: FactoryTaskId(id), identifier: id.toUpperCase(), projectId, flowId, title: id, description: '', prompt: id,
    status: 'queued', priority: 1, labels: [], dependencyIds: [], lane: { mode: 'isolated' }, finalizer: false,
    attachments: [], comments: [], createdAt: now, updatedAt: now, ...overrides,
  }
}

describe('Factory task discussion projection', () => {
  it('merges saved notes with posted and steered user prompts while excluding the Factory assignment', () => {
    const base = Date.parse(now)
    const value = task('discussion', {
      comments: [{
        id: FactoryCommentId('comment:one'), author: 'agent', body: 'Waiting on your decision.',
        createdAt: '2026-08-23T00:00:02.000Z',
      }],
    })
    const snapshot = {
      nodes: [
        {
          kind: 'user', seq: 1, time: base, content: [{ type: 'text', text: 'Initial assignment' }],
          source: { kind: 'factory-task' },
        },
        {
          kind: 'user', seq: 3, time: base + 3_000, content: [{ type: 'text', text: 'Queued follow-up' }],
          source: { kind: 'user' },
        },
        {
          kind: 'steering', messageId: 'message:steer', seq: 2, time: base + 1_000,
          content: [{ type: 'text', text: 'Steer immediately' }], source: { kind: 'user' },
        },
      ],
    } as ConversationSnapshot

    expect(factoryDiscussionItems(value, snapshot)).toEqual([
      expect.objectContaining({ key: 'session:2', body: 'Steer immediately', delivery: 'steered' }),
      expect.objectContaining({ key: 'factory:comment:one', body: 'Waiting on your decision.', delivery: 'comment' }),
      expect.objectContaining({ key: 'session:3', body: 'Queued follow-up', delivery: 'posted' }),
    ])
  })
})

describe('Factory recurring schedule composer', () => {
  it('round-trips a friendly recurring schedule as an enabled durable automation', () => {
    const schedule = { kind: 'weekly' as const, weekdays: [1, 4], hour: 9, minute: 30 }
    const automation = automationSpec('recurring', '', schedule)
    expect(automation).toEqual({ enabled: true, trigger: { kind: 'recurring', schedule } })
    expect(automationMode(automation)).toBe('recurring')
  })
})

describe('Factory queue graph presentation', () => {
  it('connects parallel sibling nodes through their shared join', () => {
    const root = task('root')
    const review = task('review', { dependencyIds: [root.id] })
    const tests = task('tests', { dependencyIds: [root.id] })
    const join = task('join', { dependencyIds: [review.id, tests.id] })
    const graph = [root, review, tests, join]

    expect(queueGraphPresentation(root, graph)).toMatchObject({ kind: 'root', start: true, railBefore: [], railAfter: [0], links: [], nodeLane: 0 })
    expect(queueGraphPresentation(review, graph)).toMatchObject({ kind: 'parallel', railBefore: [0], railAfter: [0, 1], links: [{ from: 0, to: 1 }], nodeLane: 1 })
    expect(queueGraphPresentation(tests, graph)).toMatchObject({ kind: 'parallel', railBefore: [0, 1], railAfter: [0, 1], links: [], nodeLane: 1 })
    expect(queueGraphPresentation(join, graph)).toMatchObject({ kind: 'join', railBefore: [0, 1], railAfter: [], links: [{ from: 1, to: 0 }], nodeLane: 0 })
  })

  it('renders pending relationship kinds as closed Lucide shapes', () => {
    const root = task('root')
    const left = task('left', { dependencyIds: [root.id] })
    const right = task('right', { dependencyIds: [root.id] })
    const join = task('join', { dependencyIds: [left.id, right.id] })
    const finalizer = task('finalizer', { dependencyIds: [join.id], finalizer: true })
    const graph = [root, left, right, join, finalizer]
    const { container } = render(<>{graph.map(item => <QueueGraphCell task={item} tasks={graph} key={item.id} />)}</>)

    expect(container.querySelectorAll('[data-segment="node"][data-state="pending"] svg')).toHaveLength(graph.length)
    expect(container.querySelector('[data-kind="root"] .lucide-circle')).not.toBeNull()
    expect(container.querySelector('[data-kind="parallel"] .lucide-triangle')).not.toBeNull()
    expect(container.querySelector('[data-kind="join"] .lucide-diamond')).not.toBeNull()
    expect(container.querySelector('[data-kind="finalizer"] .lucide-square')).not.toBeNull()
  })

  it('uses only the vertical spine for sequential and finalizer edges', () => {
    const root = task('root')
    const review = task('review', { dependencyIds: [root.id] })
    const publish = task('publish', { dependencyIds: [review.id], finalizer: true })
    const graph = [root, review, publish]

    expect(queueGraphPresentation(review, graph)).toMatchObject({ kind: 'sequential', railBefore: [0], railAfter: [0], links: [], nodeLane: 0 })
    expect(queueGraphPresentation(publish, graph)).toMatchObject({ kind: 'finalizer', railBefore: [0], railAfter: [], links: [], nodeLane: 0 })
  })

  it('terminates a fan-out without inventing a join edge', () => {
    const root = task('root')
    const first = task('first', { dependencyIds: [root.id] })
    const second = task('second', { dependencyIds: [root.id] })
    const graph = [root, first, second]

    expect(queueGraphPresentation(first, graph)).toMatchObject({ kind: 'parallel', railBefore: [0], railAfter: [0, 1], links: [{ from: 0, to: 1 }], nodeLane: 1 })
    expect(queueGraphPresentation(second, graph)).toMatchObject({ kind: 'parallel', railBefore: [0, 1], railAfter: [], links: [], nodeLane: 1 })
  })

  it('connects a three-way branch into a join that continues to a finalizer', () => {
    const root = task('root')
    const review = task('review', { dependencyIds: [root.id] })
    const tests = task('tests', { dependencyIds: [root.id] })
    const docs = task('docs', { dependencyIds: [root.id] })
    const join = task('join', { dependencyIds: [review.id, tests.id, docs.id] })
    const publish = task('publish', { dependencyIds: [join.id], finalizer: true })
    const graph = [root, review, tests, docs, join, publish]

    const branches = orderTaskGraph(graph).filter(candidate => candidate.dependencyIds.length === 1 && candidate.dependencyIds[0] === root.id)
    expect(branches.map(candidate => queueGraphPresentation(candidate, graph))).toEqual([
      expect.objectContaining({ railBefore: [0], railAfter: [0, 1], links: [{ from: 0, to: 1 }] }),
      expect.objectContaining({ railBefore: [0, 1], railAfter: [0, 1], links: [] }),
      expect.objectContaining({ railBefore: [0, 1], railAfter: [0, 1], links: [] }),
    ])
    expect(queueGraphPresentation(join, graph)).toMatchObject({ kind: 'join', railBefore: [0, 1], railAfter: [0], links: [{ from: 1, to: 0 }], nodeLane: 0 })
    expect(queueGraphPresentation(publish, graph)).toMatchObject({ kind: 'finalizer', railBefore: [0], railAfter: [], nodeLane: 0 })
  })

  it('supports parallel roots and a shared first join', () => {
    const left = task('left')
    const right = task('right')
    const join = task('join', { dependencyIds: [left.id, right.id] })
    const graph = [left, right, join]

    expect(queueGraphPresentation(left, graph)).toMatchObject({ kind: 'parallel', label: 'Parallel root', start: true, railBefore: [], railAfter: [0, 1], links: [{ from: 0, to: 1 }], nodeLane: 1 })
    expect(queueGraphPresentation(right, graph)).toMatchObject({ kind: 'parallel', label: 'Parallel root', start: true, railBefore: [0, 1], railAfter: [0, 1], links: [], nodeLane: 1 })
    expect(queueGraphPresentation(join, graph)).toMatchObject({ kind: 'join', railBefore: [0, 1], links: [{ from: 1, to: 0 }], nodeLane: 0 })
  })

  it('carries a branch lane through nested descendants before their common join', () => {
    const root = task('root')
    const left = task('left', { dependencyIds: [root.id] })
    const right = task('right', { dependencyIds: [root.id] })
    const leftCheck = task('left-check', { dependencyIds: [left.id] })
    const rightCheck = task('right-check', { dependencyIds: [right.id] })
    const join = task('join', { dependencyIds: [leftCheck.id, rightCheck.id] })
    const graph = [root, left, right, leftCheck, rightCheck, join]

    expect(queueGraphPresentation(leftCheck, graph)).toMatchObject({ kind: 'sequential', nodeLane: 1, railBefore: [0, 1], railAfter: [0, 1], links: [] })
    expect(queueGraphPresentation(rightCheck, graph)).toMatchObject({ kind: 'sequential', nodeLane: 1, railBefore: [0, 1], railAfter: [0, 1], links: [] })
    expect(queueGraphPresentation(join, graph)).toMatchObject({ kind: 'join', nodeLane: 0, railBefore: [0, 1], railAfter: [], links: [{ from: 1, to: 0 }] })
  })

  it('allocates a second reusable rail for nested fan-outs and returns local joins to their parent rail', () => {
    const root = task('root')
    const left = task('left', { dependencyIds: [root.id] })
    const right = task('right', { dependencyIds: [root.id] })
    const leftUnit = task('left-1-unit', { dependencyIds: [left.id] })
    const leftA11y = task('left-2-a11y', { dependencyIds: [left.id] })
    const leftJoin = task('left-join', { dependencyIds: [leftUnit.id, leftA11y.id] })
    const rightUnit = task('right-1-unit', { dependencyIds: [right.id] })
    const rightApi = task('right-2-api', { dependencyIds: [right.id] })
    const rightJoin = task('right-join', { dependencyIds: [rightUnit.id, rightApi.id] })
    const outerJoin = task('outer-join', { dependencyIds: [leftJoin.id, rightJoin.id] })
    const graph = [root, left, right, leftUnit, leftA11y, leftJoin, rightUnit, rightApi, rightJoin, outerJoin]

    expect(queueGraphPresentation(leftUnit, graph)).toMatchObject({
      nodeLane: 2, maxLane: 2, railBefore: [0, 1], railAfter: [0, 1, 2], links: [{ from: 1, to: 2 }],
    })
    expect(queueGraphPresentation(leftA11y, graph)).toMatchObject({ nodeLane: 2, railBefore: [0, 1, 2], railAfter: [0, 1, 2], links: [] })
    expect(queueGraphPresentation(leftJoin, graph)).toMatchObject({ nodeLane: 1, railBefore: [0, 1, 2], railAfter: [0, 1], links: [{ from: 2, to: 1 }] })
    expect(queueGraphPresentation(rightUnit, graph)).toMatchObject({ nodeLane: 2, links: [{ from: 1, to: 2 }] })
    expect(queueGraphPresentation(rightJoin, graph)).toMatchObject({ nodeLane: 1, links: [{ from: 2, to: 1 }] })
    expect(queueGraphPresentation(outerJoin, graph)).toMatchObject({ nodeLane: 0, links: [{ from: 1, to: 0 }] })
  })

  it('allocates an additional lane for each overlapping branch depth', () => {
    const root = task('500-root')
    const left = task('501-left', { dependencyIds: [root.id] })
    const right = task('502-right', { dependencyIds: [root.id] })
    const middleA = task('503-middle-a', { dependencyIds: [left.id] })
    const middleB = task('504-middle-b', { dependencyIds: [left.id] })
    const deepA = task('505-deep-a', { dependencyIds: [middleA.id] })
    const deepB = task('506-deep-b', { dependencyIds: [middleA.id] })
    const deepJoin = task('507-deep-join', { dependencyIds: [deepA.id, deepB.id] })
    const middleJoin = task('508-middle-join', { dependencyIds: [deepJoin.id, middleB.id] })
    const outerJoin = task('509-outer-join', { dependencyIds: [middleJoin.id, right.id] })
    const graph = [root, left, right, middleA, middleB, deepA, deepB, deepJoin, middleJoin, outerJoin]

    expect(queueGraphPresentation(deepA, graph)).toMatchObject({ nodeLane: 3, maxLane: 3, links: [{ from: 2, to: 3 }] })
    expect(queueGraphPresentation(deepJoin, graph)).toMatchObject({ nodeLane: 2, links: [{ from: 3, to: 2 }] })
    expect(queueGraphPresentation(middleJoin, graph)).toMatchObject({ nodeLane: 1, links: [{ from: 2, to: 1 }] })
    expect(queueGraphPresentation(outerJoin, graph)).toMatchObject({ nodeLane: 0, links: [{ from: 1, to: 0 }] })
  })

  it('marks completed, in-progress, and abruptly failed rail nodes distinctly', () => {
    const completed = task('completed', { status: 'succeeded' })
    const running = task('running', { status: 'running', dependencyIds: [completed.id] })
    const failed = task('failed-abruptly', { status: 'failed', dependencyIds: [running.id], failure: 'Session disappeared' })
    const graph = [completed, running, failed]

    expect(queueGraphPresentation(completed, graph)).toMatchObject({ state: 'succeeded' })
    expect(queueGraphPresentation(running, graph)).toMatchObject({ state: 'running' })
    expect(queueGraphPresentation(failed, graph)).toMatchObject({ state: 'failed' })

    const { container } = render(<>{graph.map(item => <QueueGraphCell task={item} tasks={graph} key={item.id} />)}</>)
    const nodes = [...container.querySelectorAll<HTMLElement>('[data-segment="node"]')]
    expect(nodes).toHaveLength(graph.length)
    expect(nodes.map(node => getComputedStyle(node).backgroundColor)).toEqual([
      'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)',
    ])
  })

  it('renders isolated and singleton-root tasks without dangling segments', () => {
    const independent = task('independent')
    delete independent.flowId
    const root = task('root')

    expect(queueGraphPresentation(independent, [independent])).toMatchObject({ kind: 'independent', start: false, railBefore: [], railAfter: [], links: [], nodeLane: 0, maxLane: 0 })
    expect(queueGraphPresentation(root, [root])).toMatchObject({ kind: 'root', start: true, railBefore: [], railAfter: [], links: [], nodeLane: 0, maxLane: 0 })
  })
})
