// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  ConversationSnapshot, SessionFace, SessionId,
} from '@monotykamary/dsh-client-runtime/client'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import {
  FactoryAttachmentId, FactoryCommentId, FactoryProjectId, FactoryTaskId, type FactoryTask,
} from 'dsh-factory-protocol'
import { FactoryTaskDiscussion } from '../src/client/FactoryTaskDiscussion.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const sessionId = 'session:comments' as SessionId
const taskId = FactoryTaskId('task:comments')

const t = ((key: keyof typeof en, values?: Record<string, string>) => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, value)
  return text
}) as TranslateNS<'factory'>

function task(): FactoryTask {
  return {
    id: taskId, identifier: 'FAC-90', projectId: FactoryProjectId('project:one'), title: 'Comment queue',
    description: '', prompt: 'Implement the comment queue', status: 'running', priority: 2, labels: [],
    dependencyIds: [], lane: { mode: 'current' }, finalizer: false, attachments: [], comments: [],
    createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
  }
}

function queueRow(id: string, text: string, placement: 'queued' | 'steering') {
  return {
    id: id as never,
    messageId: id as never,
    placement,
    content: [{ type: 'text' as const, text }],
    preview: text,
    text,
  }
}

function snapshot(): ConversationSnapshot {
  return {
    sessionId,
    views: {} as never,
    chat: {} as never,
    nodes: [{
      kind: 'user', seq: 4, time: Date.parse('2026-08-23T00:00:04.000Z'),
      content: [{ type: 'text', text: 'Already posted prompt' }], source: { kind: 'user' },
    }],
    turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [], pending: [],
    queue: [
      queueRow('message:first', 'First queued prompt with complete context.', 'queued'),
      queueRow('message:second', 'Second queued prompt to move.', 'queued'),
      queueRow('message:steering', 'Steering at the next safe step.', 'steering'),
    ],
    running: true, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null,
    lastAgentError: null,
  }
}

function session(value: ConversationSnapshot) {
  const updateQueue = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const prompt = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const readAttachment = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: {
      attachment: { attachmentId: 'attachment:test', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 },
      data: new Uint8Array([120]),
    },
  }))
  return {
    face: {
      sessionId,
      subscribe: () => () => undefined,
      getSnapshot: () => value,
      updateQueue,
      prompt,
      readAttachment,
    } as unknown as SessionFace,
    updateQueue,
    prompt,
    readAttachment,
  }
}

describe('Factory task prompt comments', () => {
  it('shows queue and steering state and routes reorder, edit, Queue, and Steer actions', async () => {
    const live = session(snapshot())
    render(<FactoryTaskDiscussion task={task()} revision={7} session={live.face} activeRun t={t} onComment={vi.fn()} />)

    expect(screen.getByText('First queued prompt with complete context.')).toBeTruthy()
    expect(screen.getAllByText('Queued · not steered')).toHaveLength(2)
    expect(screen.getByText('Steered · waiting to post')).toBeTruthy()
    expect(screen.getByText('Already posted prompt')).toBeTruthy()
    expect(screen.getByText('Posted')).toBeTruthy()
    expect(screen.queryByText('Prompt queue')).toBeNull()
    const ordered = within(screen.getByRole('list', { name: 'Comments' })).getAllByRole('listitem')
    expect(ordered.map(item => item.textContent)).toEqual([
      expect.stringContaining('Already posted prompt'),
      expect.stringContaining('Steering at the next safe step.'),
      expect.stringContaining('First queued prompt with complete context.'),
      expect.stringContaining('Second queued prompt to move.'),
    ])

    const moveEarlier = screen.getAllByLabelText('Move prompt earlier') as HTMLButtonElement[]
    expect(moveEarlier[0]?.disabled).toBe(true)
    expect(moveEarlier[1]?.disabled).toBe(false)
    fireEvent.click(moveEarlier[1]!)
    await waitFor(() => {
      expect(live.updateQueue).toHaveBeenCalledWith('message:second', { kind: 'move', direction: 'earlier' })
    })

    fireEvent.click(screen.getAllByLabelText('Edit queued prompt')[1]!)
    const editor = screen.getByRole('textbox', { name: 'Edit queued prompt' })
    fireEvent.change(editor, { target: { value: 'Edited second prompt' } })
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })
    await waitFor(() => {
      expect(live.updateQueue).toHaveBeenCalledWith('message:second', {
        kind: 'edit', content: [{ type: 'text', text: 'Edited second prompt' }],
      })
    })

    const composer = screen.getByPlaceholderText('Add a prompt or steer the running agent…')
    fireEvent.change(composer, { target: { value: 'Queue this follow-up' } })
    fireEvent.click(screen.getByText('Queue prompt'))
    await waitFor(() => {
      expect(live.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'Queue this follow-up' }], 'queue')
    })

    fireEvent.change(composer, { target: { value: 'Steer with this correction' } })
    fireEvent.click(screen.getByText('Steer now'))
    await waitFor(() => {
      expect(live.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'Steer with this correction' }], 'steer')
    })
  })

  it('pastes image-only prompts and opens queued, posted, and draft thumbnails fullscreen', async () => {
    const attachment = {
      attachmentId: 'attachment:comment-image' as never,
      mediaType: 'image/png' as const,
      bytes: 1,
      width: 40,
      height: 30,
      name: 'screenshot.png',
    }
    const base = snapshot()
    const firstQueue = base.queue[0]
    const firstNode = base.nodes[0]
    if (firstQueue === undefined || firstNode?.kind !== 'user') throw new Error('image fixture is incomplete')
    const value = {
      ...base,
      queue: [{ ...firstQueue, content: [{ type: 'image' as const, attachment }, ...firstQueue.content] }, ...base.queue.slice(1)],
      nodes: [{ ...firstNode, content: [{ type: 'image' as const, attachment }, ...firstNode.content] }],
    } as ConversationSnapshot
    const live = session(value)
    const commentTask = task()
    commentTask.comments = [{
      id: FactoryCommentId('comment:gallery'), author: 'user', body: 'Two-image evidence',
      attachments: [
        { id: FactoryAttachmentId('attachment:first'), name: 'first.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,Zmlyc3Q=' },
        { id: FactoryAttachmentId('attachment:second'), name: 'second.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,c2Vjb25k' },
      ],
      createdAt: '2026-08-23T00:00:03.000Z',
    }]
    render(<FactoryTaskDiscussion task={commentTask} revision={10} session={live.face} activeRun t={t} onComment={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'screenshot.png' })).toHaveLength(2)
      expect(screen.getByRole('button', { name: 'first.png' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'second.png' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'first.png' }))
    const carousel = screen.getByRole('dialog', { name: 'Original image preview' })
    expect(within(carousel).getByText('1 of 2')).toBeTruthy()
    fireEvent.click(within(carousel).getByRole('button', { name: 'Next' }))
    expect(within(carousel).getByRole('img', { name: 'second.png' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close original image preview' }))

    fireEvent.click(screen.getAllByRole('button', { name: 'screenshot.png' })[0]!)
    expect(screen.getByRole('dialog', { name: 'Original image preview' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close original image preview' }))

    const file = new File([new Uint8Array([120])], 'pasted.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: () => Promise.resolve(new Uint8Array([120]).buffer),
    })
    const composer = screen.getByPlaceholderText('Add a prompt or steer the running agent…')
    fireEvent.paste(composer, { clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] } })
    const draft = await screen.findByRole('img', { name: 'pasted.png' })
    fireEvent.click(draft.closest('button')!)
    expect(screen.getByRole('dialog', { name: 'Original image preview' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close original image preview' }))
    fireEvent.click(screen.getByText('Queue prompt'))

    await waitFor(() => {
      expect(live.prompt).toHaveBeenCalledWith([{
        type: 'image', mediaType: 'image/png', data: 'eA==', name: 'pasted.png',
      }], 'queue')
    })
  })

  it('replaces prompt entry with a human-response gate while ask_user_question is pending', () => {
    const value = snapshot()
    value.pending = [{
      kind: 'question', key: 'q:factory-review', sessionId,
      payload: { questions: [
        { id: 'release', header: 'Release decision', question: 'Should the next dependency publish this build?' },
        { id: 'target', question: 'Which environment should receive it?' },
      ] },
    } as never]
    const live = session(value)
    const onOpenSession = vi.fn()

    render(<FactoryTaskDiscussion task={task()} revision={8} session={live.face} activeRun t={t} onOpenSession={onOpenSession} onComment={vi.fn()} />)

    expect(screen.getByText('Agent needs your answer')).toBeTruthy()
    expect(screen.getByText('This task and its dependent work stay paused until you respond.')).toBeTruthy()
    expect(screen.getByText('Should the next dependency publish this build?')).toBeTruthy()
    expect(screen.getByText('Which environment should receive it?')).toBeTruthy()
    expect(screen.queryByPlaceholderText('Add a prompt or steer the running agent…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Answer in Session' }))
    expect(onOpenSession).toHaveBeenCalledOnce()
  })

  it('holds active-task input while its Session binding is still connecting', () => {
    const onComment = vi.fn(() => Promise.resolve())
    render(<FactoryTaskDiscussion task={task()} revision={8} activeRun t={t} onComment={onComment} />)

    const composer = screen.getByPlaceholderText('Connecting to the task Session…') as HTMLTextAreaElement
    expect(composer.disabled).toBe(true)
    expect((screen.getByText('Connecting…').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(onComment).not.toHaveBeenCalled()
  })

  it('keeps historical Session prompts visible but saves new terminal-task input as a Factory note', async () => {
    const live = session(snapshot())
    const onComment = vi.fn(() => Promise.resolve())
    render(<FactoryTaskDiscussion task={task()} revision={9} session={live.face} activeRun={false} t={t} onComment={onComment} />)

    expect(screen.getByText('Already posted prompt')).toBeTruthy()
    const composer = screen.getByPlaceholderText('Leave a comment…')
    const file = new File([new Uint8Array([121])], 'evidence.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: () => Promise.resolve(new Uint8Array([121]).buffer),
    })
    fireEvent.paste(composer, { clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] } })
    fireEvent.change(composer, { target: { value: 'Retrospective note' } })
    fireEvent.click(screen.getByText('Add comment'))
    await waitFor(() => {
      expect(onComment).toHaveBeenCalledWith({
        taskId, expectedRevision: 9, body: 'Retrospective note',
        attachments: [{ name: 'evidence.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,eQ==' }],
      })
    })
    expect(live.prompt).not.toHaveBeenCalled()
  })

  it('keeps rendered comment images across polling re-renders', async () => {
    const withImage = (): FactoryTask => {
      const value = task()
      value.comments.push({
        id: FactoryCommentId('comment:image'), author: 'user', body: 'See this screenshot',
        attachments: [{
          id: FactoryAttachmentId('attachment:screenshot'), name: 'shot.png', mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,cG5n', createdAt: '2026-08-23T00:00:01.000Z',
        }],
        createdAt: '2026-08-23T00:00:01.000Z',
      })
      return value
    }
    const onComment = vi.fn(() => Promise.resolve())
    const view = render(<FactoryTaskDiscussion task={withImage()} revision={9} activeRun={false} t={t} onComment={onComment} />)

    const rail = await screen.findByRole('group', { name: t('image.group') })
    expect(rail.querySelectorAll('img')).toHaveLength(1)

    view.rerender(<FactoryTaskDiscussion task={withImage()} revision={9} activeRun={false} t={t} onComment={onComment} />)
    expect(rail.querySelectorAll('img')).toHaveLength(1)
    expect(screen.queryByText(t('image.loading'))).toBeNull()
  })
})
