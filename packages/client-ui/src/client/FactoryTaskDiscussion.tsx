import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ImageLoader } from '@monotykamary/dsh-client-ui-attachment/client'
import {
  Button, Check, ChevronDown, ChevronUp, CircleHelp, Clock3, ListPlus, MarkdownText,
  MessageSquareText, Pencil, Send, Trash2, X,
} from '@monotykamary/dsh-client-ui-primitives'
import type {
  ConversationSnapshot, QueuedMessage, SessionFace,
} from '@monotykamary/dsh-client-runtime/client'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import type {
  FactoryAttachment, FactoryAttachmentInput, FactoryCommentRequest, FactoryTask,
} from 'dsh-factory-protocol'
import { FactoryMediaRail, type FactoryMediaRailLabels, type FactoryPreviewMedia } from './FactoryMediaRail.tsx'
import css from './FactoryApp.module.css'

type QueueAction = Parameters<SessionFace['updateQueue']>[1]
type PromptContent = Parameters<SessionFace['prompt']>[0]
type PromptImage = Extract<PromptContent[number], { type: 'image' }>
type GalleryAttachment = Parameters<ImageLoader>[0]
interface GalleryImage { attachment: GalleryAttachment }
type PromptMode = 'queue' | 'steer'
type DeliveryState = 'comment' | 'posted' | 'steered'

interface DiscussionItem {
  key: string
  author: 'user' | 'agent' | 'system'
  body: string
  images: readonly GalleryImage[]
  imageSources?: ReadonlyMap<string, string>
  time: number
  delivery: DeliveryState
}

interface DraftImage {
  id: string
  file: File
  previewUrl: string
}

interface DiscussionImageLabels {
  image: string
  loading: string
  loadFailed: string
  media: FactoryMediaRailLabels
}

interface Props {
  task: FactoryTask
  revision: number
  session?: SessionFace | undefined
  activeRun: boolean
  t: TranslateNS<'factory'>
  onOpenSession?: (() => void) | undefined
  onComment: (request: FactoryCommentRequest) => Promise<void>
}

interface SurfaceProps extends Props {
  sessionSnapshot?: ConversationSnapshot | undefined
}

let draftImageSequence = 0

function userSource(source: unknown): boolean {
  return typeof source === 'object' && source !== null
    && 'kind' in source && source.kind === 'user'
}

function messageParts(content: readonly unknown[]): { body: string; images: GalleryImage[] } {
  const text: string[] = []
  const images: GalleryImage[] = []
  for (const block of content) {
    const candidate = block as { type?: string; text?: string; attachment?: GalleryAttachment }
    if (candidate.type === 'text' && typeof candidate.text === 'string') text.push(candidate.text)
    else if (candidate.type === 'image' && candidate.attachment !== undefined) images.push({ attachment: candidate.attachment })
    else text.push(`[${candidate.type ?? 'content'}]`)
  }
  return { body: text.join('\n').trim(), images }
}

function factoryCommentImages(attachments: readonly FactoryAttachment[]): {
  images: GalleryImage[]
  sources: ReadonlyMap<string, string>
} {
  const sources = new Map<string, string>()
  const images = attachments.map((attachment) => {
    sources.set(String(attachment.id), attachment.dataUrl)
    return {
      attachment: {
        attachmentId: attachment.id as unknown as GalleryAttachment['attachmentId'],
        mediaType: mediaType(attachment.mediaType),
        bytes: Math.max(1, Math.floor(attachment.dataUrl.length * 0.75)),
        width: 240,
        height: 240,
        ...(attachment.name === '' ? {} : { name: attachment.name }),
      },
    }
  })
  return { images, sources }
}

/** Project durable tracker comments and posted human Session messages into one task discussion. */
export function factoryDiscussionItems(
  task: FactoryTask,
  snapshot?: ConversationSnapshot,
): readonly DiscussionItem[] {
  const items: DiscussionItem[] = task.comments.map((comment) => {
    const projected = factoryCommentImages(comment.attachments ?? [])
    return {
      key: `factory:${comment.id}`,
      author: comment.author,
      body: comment.body,
      images: projected.images,
      imageSources: projected.sources,
      time: Date.parse(comment.createdAt),
      delivery: 'comment',
    }
  })
  for (const node of snapshot?.nodes ?? []) {
    if (node.kind === 'user' && userSource(node.source)) {
      const parts = messageParts(node.content)
      items.push({
        key: `session:${String(node.seq)}`,
        author: 'user',
        body: parts.body,
        images: parts.images,
        time: node.time,
        delivery: 'posted',
      })
    } else if (node.kind === 'steering') {
      const parts = messageParts(node.content)
      items.push({
        key: `session:${String(node.seq)}`,
        author: 'user',
        body: parts.body,
        images: parts.images,
        time: node.time,
        delivery: 'steered',
      })
    }
  }
  return items.toSorted((left, right) => left.time - right.time)
}

function authorLabel(author: DiscussionItem['author'], t: TranslateNS<'factory'>): string {
  if (author === 'user') return t('comment.you')
  if (author === 'agent') return t('comment.agent')
  return t('comment.system')
}

function deliveryLabel(delivery: DeliveryState, t: TranslateNS<'factory'>): string {
  if (delivery === 'posted') return t('comment.posted')
  if (delivery === 'steered') return t('comment.steered')
  return t('comment.note')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mediaType(value: string): PromptImage['mediaType'] {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return value
    default:
      throw new Error(`Unsupported image type: ${value || '(empty)'}`)
  }
}

function previewUrl(file: File): string {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : `data:${file.type},`
}

function revokePreview(url: string): void {
  if (url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}

function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < data.length; offset += chunk) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

async function encodeDraftImages(images: readonly DraftImage[]): Promise<{
  prompt: readonly PromptImage[]
  attachments: readonly FactoryAttachmentInput[]
}> {
  const encoded = await Promise.all(images.map(async (image) => {
    const type = mediaType(image.file.type)
    const data = bytesToBase64(new Uint8Array(await image.file.arrayBuffer()))
    return {
      prompt: { type: 'image' as const, mediaType: type, data, ...(image.file.name === '' ? {} : { name: image.file.name }) },
      attachment: { name: image.file.name, mediaType: type, dataUrl: `data:${type};base64,${data}` },
    }
  }))
  return { prompt: encoded.map(image => image.prompt), attachments: encoded.map(image => image.attachment) }
}

function LiveDiscussion(props: Props & { session: SessionFace }) {
  const sessionSnapshot = useSyncExternalStore(
    listener => props.session.subscribe(listener),
    () => props.session.getSnapshot(),
    () => props.session.getSnapshot(),
  )
  return <DiscussionSurface {...props} sessionSnapshot={sessionSnapshot} />
}

/** Task comments backed by the active DSH Session queue when one exists. */
export function FactoryTaskDiscussion(props: Props) {
  return props.session === undefined
    ? <DiscussionSurface {...props} />
    : <LiveDiscussion {...props} session={props.session} />
}

function DiscussionImages({ images, sources, loadSession, labels }: {
  images: readonly GalleryImage[]
  sources?: ReadonlyMap<string, string> | undefined
  loadSession: (attachment: GalleryAttachment) => Promise<string>
  labels: DiscussionImageLabels
}) {
  const [items, setItems] = useState<readonly FactoryPreviewMedia[]>([])
  const [loading, setLoading] = useState(images.length > 0)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const load = useCallback((attachment: GalleryAttachment): Promise<string> => {
    const source = sources?.get(String(attachment.attachmentId))
    return source === undefined ? loadSession(attachment) : Promise.resolve(source)
  }, [loadSession, sources])
  // Reload only when the attachment set changes; polling rebuilds the images
  // array every render with identical content and must not blank the rail.
  const latest = useRef({ images, load })
  useEffect(() => { latest.current = { images, load } })
  const imagesKey = images.map(({ attachment }) => `${attachment.mediaType}:${attachment.name ?? ''}:${String(attachment.bytes)}`).join('\n')
  useEffect(() => {
    const current = latest.current
    let live = true
    setItems([])
    setLoading(current.images.length > 0)
    setFailed(false)
    void Promise.allSettled(current.images.map(async ({ attachment }, index) => ({
      id: `${String(attachment.attachmentId)}:${String(index)}`,
      previewUrl: await current.load(attachment),
      alt: attachment.name ?? labels.image,
    } satisfies FactoryPreviewMedia))).then((results) => {
      if (!live) return
      setItems(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []))
      setFailed(results.some(result => result.status === 'rejected'))
      setLoading(false)
    })
    return () => { live = false }
  }, [attempt, imagesKey, labels.image])

  if (images.length === 0) return null
  return (
    <div className={css.commentMedia}>
      {items.length === 0 ? null : <FactoryMediaRail items={items} labels={labels.media} />}
      {loading ? <span className={css.commentMediaState}>{labels.loading}</span> : null}
      {!failed ? null : <button type="button" className={css.commentMediaRetry} onClick={() => { setAttempt(value => value + 1) }}>{labels.loadFailed}</button>}
    </div>
  )
}

function DiscussionSurface({ task, revision, session, activeRun, sessionSnapshot, t, onOpenSession, onComment }: SurfaceProps) {
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<readonly DraftImage[]>([])
  const draftImagesRef = useRef(draftImages)
  const [editing, setEditing] = useState<{ id: QueuedMessage['id']; text: string }>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const pending = useMemo(() => {
    const visible = (sessionSnapshot?.queue ?? []).filter(row => row.placement !== 'context')
    return visible.toSorted((left, right) => Number(left.placement !== 'steering') - Number(right.placement !== 'steering'))
  }, [sessionSnapshot?.queue])
  const queued = useMemo(() => pending.filter(row => row.placement === 'queued'), [pending])
  const discussion = useMemo(() => factoryDiscussionItems(task, sessionSnapshot), [sessionSnapshot, task])
  const pendingQuestion = activeRun
    ? sessionSnapshot?.pending.find(interaction => interaction.kind === 'question')
    : undefined
  const promptable = activeRun && session !== undefined
  const sessionPending = activeRun && session === undefined
  const canSteer = promptable && sessionSnapshot?.running === true
  const canMutateQueue = promptable && sessionSnapshot?.subagent === null && sessionSnapshot.removed === false
  const hasDraft = draft.trim() !== '' || draftImages.length > 0
  const imageLabels = useMemo<DiscussionImageLabels>(() => ({
    image: t('image.pending'),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    media: {
      group: t('image.group'),
      open: t('image.open'),
      scrollLeft: t('image.scrollLeft'),
      scrollRight: t('image.scrollRight'),
      dialog: t('image.preview'),
      close: t('image.closePreview'),
      previous: t('image.previous'),
      next: t('image.next'),
      position: (current, total) => t('image.position', { current: String(current), total: String(total) }),
    },
  }), [t])

  useEffect(() => { draftImagesRef.current = draftImages }, [draftImages])
  useEffect(() => () => {
    for (const image of draftImagesRef.current) revokePreview(image.previewUrl)
  }, [])
  useEffect(() => {
    if (editing !== undefined && !queued.some(row => row.id === editing.id)) setEditing(undefined)
  }, [editing, queued])

  const loadSessionImage = useCallback(async (attachment: GalleryAttachment): Promise<string> => {
    if (session === undefined) throw new Error('Task Session is unavailable')
    const result = await session.readAttachment(attachment.attachmentId)
    if (!result.ok) throw new Error(result.error.message)
    return `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`
  }, [session])
  const draftRail = useMemo<FactoryPreviewMedia[]>(() => draftImages.map(image => ({
    id: image.id,
    previewUrl: image.previewUrl,
    alt: image.file.name || t('image.pending'),
    removeLabel: t('image.remove', { name: image.file.name || t('image.pending') }),
  })), [draftImages, t])
  const addDraftImages = useCallback((files: readonly File[]): void => {
    if (files.length === 0) return
    try {
      for (const file of files) mediaType(file.type)
      const created = files.map((file) => ({
        id: `factory-comment-image:${String(++draftImageSequence)}`,
        file,
        previewUrl: previewUrl(file),
      }))
      setDraftImages(current => [...current, ...created])
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [])
  const removeDraftImage = useCallback((image: DraftImage): void => {
    revokePreview(image.previewUrl)
    setDraftImages(current => current.filter(candidate => candidate.id !== image.id))
  }, [])
  const clearDraftImages = (): void => {
    for (const image of draftImages) revokePreview(image.previewUrl)
    setDraftImages([])
  }

  const updateQueue = async (row: QueuedMessage, action: QueueAction): Promise<boolean> => {
    if (session === undefined || busy !== undefined) return false
    setBusy(row.id); setError(undefined)
    try {
      const result = await session.updateQueue(row.id, action)
      if (!result.ok) throw new Error(result.error.message)
      return true
    } catch (failure) {
      setError(errorText(failure))
      return false
    } finally {
      setBusy(undefined)
    }
  }

  const editedContent = (row: QueuedMessage, text: string): QueuedMessage['content'] => [
    ...row.content.filter(block => block.type !== 'text'),
    { type: 'text', text },
  ]

  const submit = async (mode: PromptMode = 'queue'): Promise<void> => {
    if (!hasDraft || busy !== undefined) return
    setBusy('composer'); setError(undefined)
    try {
      if (sessionPending) return
      const encoded = await encodeDraftImages(draftImages)
      if (!activeRun) {
        await onComment({ taskId: task.id, expectedRevision: revision, body: draft, attachments: [...encoded.attachments] })
      } else {
        if (session === undefined) return
        const content: PromptContent = [...encoded.prompt, ...(draft.trim() === '' ? [] : [{ type: 'text', text: draft }])]
        const result = await session.prompt(content, mode)
        if (!result.ok) throw new Error(result.error.message)
      }
      setDraft('')
      clearDraftImages()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className={css.cardSection} data-testid="factory-task-comments">
      <div className={css.sectionTitle}><MessageSquareText size={15} /><h2>{t('comments')}</h2></div>

      <div className={css.commentFeed} role="list" aria-label={t('comments')}>
        {discussion.length === 0 && pending.length === 0 && pendingQuestion === undefined ? <div className={css.commentEmpty}>{t('comment.empty')}</div> : null}
        {discussion.map(item => (
          <article className={css.comment} data-state={item.delivery} role="listitem" key={item.key}>
            <header className={css.commentMeta}>
              <span className={css.commentAuthor}><b>{authorLabel(item.author, t).slice(0, 1)}</b><strong>{authorLabel(item.author, t)}</strong></span>
              <span><time>{new Date(item.time).toLocaleString()}</time><span className={css.deliveryBadge} data-state={item.delivery}>{deliveryLabel(item.delivery, t)}</span></span>
            </header>
            <DiscussionImages images={item.images} sources={item.imageSources} loadSession={loadSessionImage} labels={imageLabels} />
            {item.body === '' ? null : <div className={css.commentBody}><MarkdownText text={item.body} /></div>}
          </article>
        ))}
        {pending.map((row) => {
          const queueIndex = queued.findIndex(candidate => candidate.id === row.id)
          const rowBusy = busy === row.id
          const rowEditing = editing?.id === row.id
          const parts = messageParts(row.content)
          return (
            <article className={css.comment} data-state={row.placement} role="listitem" key={row.id}>
              <header className={css.commentMeta}>
                <span className={css.commentAuthor}><b>Y</b><strong>{t('comment.you')}</strong></span>
                <span className={css.deliveryBadge} data-state={row.placement}>
                  {row.placement === 'steering' ? t('comment.steeredPending') : t('comment.queued')}
                </span>
              </header>
              <DiscussionImages images={parts.images} loadSession={loadSessionImage} labels={imageLabels} />
              {rowEditing ? (
                <textarea
                  autoFocus
                  className={css.queuedCommentEditor}
                  aria-label={t('comment.edit')}
                  rows={3}
                  value={editing.text}
                  onChange={event => { setEditing({ id: row.id, text: event.currentTarget.value }) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setEditing(undefined)
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      if (editing.text.trim() !== '') void updateQueue(row, {
                        kind: 'edit', content: editedContent(row, editing.text),
                      }).then(saved => { if (saved) setEditing(undefined) })
                    }
                  }}
                />
              ) : parts.body === '' ? null : <div className={css.commentBody}><MarkdownText text={parts.body} /></div>}
              {row.placement !== 'queued' || !canMutateQueue ? null : (
                <div className={css.queuedCommentActions}>
                  {rowEditing ? (
                    <>
                      <button
                        type="button"
                        aria-label={t('comment.save')}
                        title={t('comment.save')}
                        disabled={rowBusy || editing.text.trim() === ''}
                        onClick={() => { void updateQueue(row, {
                          kind: 'edit', content: editedContent(row, editing.text),
                        }).then(saved => { if (saved) setEditing(undefined) }) }}
                      ><Check size={14} /></button>
                      <button type="button" aria-label={t('comment.cancel')} title={t('comment.cancel')} disabled={rowBusy} onClick={() => { setEditing(undefined) }}><X size={14} /></button>
                    </>
                  ) : (
                    <>
                      <button type="button" aria-label={t('comment.moveEarlier')} title={t('comment.moveEarlier')} disabled={rowBusy || queueIndex === 0} onClick={() => { void updateQueue(row, { kind: 'move', direction: 'earlier' }) }}><ChevronUp size={14} /></button>
                      <button type="button" aria-label={t('comment.moveLater')} title={t('comment.moveLater')} disabled={rowBusy || queueIndex === queued.length - 1} onClick={() => { void updateQueue(row, { kind: 'move', direction: 'later' }) }}><ChevronDown size={14} /></button>
                      <button type="button" aria-label={t('comment.edit')} title={t('comment.edit')} disabled={rowBusy || row.text === null} onClick={() => { if (row.text !== null) setEditing({ id: row.id, text: row.text }) }}><Pencil size={14} /></button>
                      <button type="button" aria-label={t('comment.remove')} title={t('comment.remove')} disabled={rowBusy} onClick={() => { void updateQueue(row, { kind: 'remove' }) }}><Trash2 size={14} /></button>
                      <button type="button" aria-label={t('comment.steerNow')} title={t('comment.steerNow')} disabled={rowBusy || !canSteer} onClick={() => { void updateQueue(row, { kind: 'steer' }) }}><Send size={14} /></button>
                    </>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>

      {pendingQuestion === undefined ? (
        <div className={css.commentComposer}>
        {draftRail.length === 0 ? null : (
          <div className={css.commentAttachmentRail}>
            <FactoryMediaRail
              items={draftRail}
              labels={imageLabels.media}
              onRemove={(item) => {
                const image = draftImages.find(candidate => candidate.id === item.id)
                if (image !== undefined) removeDraftImage(image)
              }}
            />
          </div>
        )}
        <textarea
          className={css.commentInput}
          rows={4}
          value={draft}
          disabled={sessionPending}
          onChange={event => { setDraft(event.target.value) }}
          onPaste={(event) => {
            if (sessionPending || busy !== undefined) return
            const files = Array.from(event.clipboardData.items)
              .filter(item => item.kind === 'file')
              .map(item => item.getAsFile())
              .filter((file): file is File => file !== null)
            addDraftImages(files)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing) return
            event.preventDefault()
            void submit(event.shiftKey && canSteer ? 'steer' : 'queue')
          }}
          placeholder={sessionPending ? t('comment.placeholderConnecting') : !activeRun ? t('comment.placeholderNote') : t('comment.placeholderPrompt')}
        />
        <div className={css.commentComposerFooter}>
          <span>{sessionPending ? t('comment.hintConnecting') : !activeRun ? t('comment.hintNote') : t('comment.hintQueue')}</span>
          <div className={css.commentSubmitActions}>
            {canSteer ? <Button size="sm" variant="outline" icon={<Send size={13} />} disabled={busy !== undefined || !hasDraft} onClick={() => { void submit('steer') }}>{t('comment.steerNow')}</Button> : null}
            <Button size="sm" variant="primary" icon={!activeRun ? <MessageSquareText size={13} /> : sessionSnapshot?.running === true ? <ListPlus size={13} /> : <Clock3 size={13} />} disabled={sessionPending || busy !== undefined || !hasDraft} onClick={() => { void submit('queue') }}>
              {sessionPending ? t('comment.connecting') : !activeRun ? t('addComment') : sessionSnapshot?.running === true ? t('comment.queuePrompt') : t('comment.sendPrompt')}
            </Button>
          </div>
        </div>
        </div>
      ) : (
        <div className={css.humanQuestionGate} role="status" data-testid="factory-human-question">
          <div className={css.humanQuestionHeading}>
            <CircleHelp size={18} />
            <div><strong>{t('comment.questionTitle')}</strong><span>{t('comment.questionHint')}</span></div>
          </div>
          <div className={css.humanQuestionList} role="list">
            {pendingQuestion.payload.questions.map((question: { id: string; question: string }) => (
              <div role="listitem" key={question.id}><MarkdownText text={question.question} /></div>
            ))}
          </div>
          <Button size="sm" variant="primary" disabled={onOpenSession === undefined} onClick={onOpenSession}>{t('comment.answerQuestion')}</Button>
        </div>
      )}
      {error === undefined ? null : <div className={css.commentError} role="alert">{error}</div>}
    </section>
  )
}
