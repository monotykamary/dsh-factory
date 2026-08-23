import { useEffect, useMemo, useRef, useState } from 'react'
import { Paperclip } from '@monotykamary/dsh-client-ui-primitives'
import type {
  FactoryArtifactMedia, FactoryArtifactMediaRequest, FactoryRunId, FactoryTaskId,
} from 'dsh-factory-protocol'
import { type FactoryRemote, remoteValue } from './factory-client.ts'
import { FactoryMediaRail, type FactoryMediaRailLabels, type FactoryPreviewMedia } from './FactoryMediaRail.tsx'
import css from './FactoryApp.module.css'

type ArtifactMediaRemote = Pick<FactoryRemote, 'artifactMedia' | 'artifactMediaData'>

type LoadedArtifactMedia = FactoryPreviewMedia & {
  media: FactoryArtifactMedia
}

const ARTIFACT_MEDIA_LABELS: FactoryMediaRailLabels = {
  group: 'Artifact media',
  open: 'Open artifact carousel',
  scrollLeft: 'Scroll artifacts left',
  scrollRight: 'Scroll artifacts right',
  dialog: 'Artifact preview',
  close: 'Close artifact preview',
  previous: 'Previous',
  next: 'Next',
  position: (current, total) => `${String(current)} of ${String(total)}`,
}

function requestFor(taskId: FactoryTaskId, runId: FactoryRunId | undefined): FactoryArtifactMediaRequest {
  return { taskId, ...(runId === undefined ? {} : { runId }) }
}

function cacheKey(media: FactoryArtifactMedia): string {
  return `${media.id}:${media.version}`
}

/** Lazy `.artifacts` image/video rail shared by task detail and exact-run Triage detail. */
export function FactoryArtifactMedia({ api, taskId, runId, refreshToken, surface }: {
  api: ArtifactMediaRemote
  taskId: FactoryTaskId
  runId?: FactoryRunId | undefined
  refreshToken: string
  surface: 'task' | 'triage'
}) {
  const [items, setItems] = useState<readonly LoadedArtifactMedia[]>([])
  const [error, setError] = useState<string>()
  const cache = useRef(new Map<string, string>())
  const request = useMemo(() => requestFor(taskId, runId), [runId, taskId])

  useEffect(() => {
    cache.current.clear()
    setItems([])
  }, [runId, taskId])

  useEffect(() => {
    let live = true
    setError(undefined)
    void api.artifactMedia(request).then(remoteValue).then(async (metadata) => {
      if (!live) return
      const currentKeys = new Set(metadata.map(cacheKey))
      for (const key of cache.current.keys()) if (!currentKeys.has(key)) cache.current.delete(key)
      const loaded = (): LoadedArtifactMedia[] => metadata.flatMap((media) => {
        const previewUrl = cache.current.get(cacheKey(media))
        return previewUrl === undefined ? [] : [{ id: media.id, previewUrl, previewKind: media.kind, alt: media.path, media }]
      })
      setItems(loaded())
      const missing = metadata.filter(media => !cache.current.has(cacheKey(media)))
      if (missing.length > 0) {
        try {
          const data = remoteValue(await api.artifactMediaData({
            ...request, media: missing.map(media => ({ mediaId: media.id, version: media.version })),
          }))
          if (!live) return
          if (data.length !== missing.length) throw new Error('Factory artifact media data did not match its listing')
          for (const value of data) {
            const media = missing.find(candidate => candidate.id === value.mediaId && candidate.version === value.version)
            if (media === undefined) throw new Error('Factory artifact media data did not match its listing')
            cache.current.set(cacheKey(media), value.dataUrl)
          }
        } catch (failure) {
          if (live) setError(failure instanceof Error ? failure.message : String(failure))
        }
      }
      if (live) setItems(loaded())
    }).catch((failure: unknown) => {
      if (!live) return
      setItems([])
      setError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { live = false }
  }, [api, refreshToken, request])

  if (items.length === 0 && error === undefined) return null
  const body = (
    <>
      {items.length === 0 ? null : (
        <FactoryMediaRail items={items} labels={ARTIFACT_MEDIA_LABELS} />
      )}
      {error === undefined ? null : <div className={css.artifactMediaError} role="status">{error}</div>}
    </>
  )
  return surface === 'task' ? (
    <section className={css.cardSection} data-testid="factory-artifact-media">
      <div className={css.sectionTitle}><Paperclip size={15} /><h2>Artifact media</h2></div>
      {body}
    </section>
  ) : (
    <section className={css.artifactMediaSection} data-testid="factory-artifact-media">
      <h4>Artifact media</h4>
      {body}
    </section>
  )
}
