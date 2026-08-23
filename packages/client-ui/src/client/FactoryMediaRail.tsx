import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, ChevronLeft, ChevronRight, X,
} from '@monotykamary/dsh-client-ui-primitives'
import {
  AttachmentRail, type AttachmentRailItem,
} from '@monotykamary/dsh-client-ui-attachment/client'
import css from './FactoryApp.module.css'

/** Resolved copy for one Factory media rail and its fullscreen carousel. */
export interface FactoryMediaRailLabels {
  /** Accessible name of the thumbnail rail. */
  group: string
  /** Thumbnail tooltip inviting the fullscreen preview. */
  open: string
  /** Accessible name of the left rail paging control. */
  scrollLeft: string
  /** Accessible name of the right rail paging control. */
  scrollRight: string
  /** Accessible name of the fullscreen dialog. */
  dialog: string
  /** Accessible name of the fullscreen close control. */
  close: string
  /** Previous-media button copy. */
  previous: string
  /** Next-media button copy. */
  next: string
  /**
   * Human-readable carousel position.
   * @param current - one-based selected position.
   * @param total - number of media items.
   * @returns localized position copy.
   */
  position: (current: number, total: number) => string
}

/** One resolved image or video shared by the compact rail and fullscreen viewer. */
export type FactoryPreviewMedia = AttachmentRailItem

function FactoryMediaViewer({ items, selectedId, labels, onSelect, onClose }: {
  items: readonly FactoryPreviewMedia[]
  selectedId: string
  labels: FactoryMediaRailLabels
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const selectedIndex = Math.max(0, items.findIndex(item => item.id === selectedId))
  const selected = items[selectedIndex]
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const move = useCallback((direction: -1 | 1) => {
    if (items.length < 2) return
    const next = (selectedIndex + direction + items.length) % items.length
    const item = items[next]
    if (item !== undefined) onSelect(item.id)
  }, [items, onSelect, selectedIndex])

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => { restoreRef.current?.focus() }
  }, [])
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [move, onClose])

  if (selected === undefined) return null
  return createPortal(
    <div className={css.mediaViewerBackdrop} role="dialog" aria-modal="true" aria-label={labels.dialog} data-presentation="floating-media">
      <div className={css.mediaViewerMask} data-testid="factory-media-viewer-mask" aria-hidden="true" onMouseDown={onClose} />
      <div className={css.mediaViewerStage}>
        {selected.previewKind === 'video'
          ? <video key={selected.id} src={selected.previewUrl} aria-label={selected.alt} controls playsInline preload="metadata" />
          : <img key={selected.id} src={selected.previewUrl} alt={selected.alt} />}
      </div>
      <div className={css.mediaViewerBar} data-testid="factory-media-viewer-controls">
        <div className={css.mediaViewerCaption}>
          <strong>{selected.alt}</strong>
          <span aria-live="polite">{labels.position(selectedIndex + 1, items.length)}</span>
        </div>
        <div className={css.mediaViewerActions}>
          {items.length < 2 ? null : <Button variant="ghost" size="sm" icon={<ChevronLeft size={15} />} aria-label={labels.previous} onClick={() => { move(-1) }}>{labels.previous}</Button>}
          {items.length < 2 ? null : <Button variant="ghost" size="sm" icon={<ChevronRight size={15} />} aria-label={labels.next} onClick={() => { move(1) }}>{labels.next}</Button>}
        </div>
      </div>
      <button ref={closeRef} type="button" className={css.mediaViewerClose} aria-label={labels.close} onClick={onClose}><X size={16} /></button>
    </div>,
    document.body,
  )
}

/**
 * Render one 64px thumbnail rail with a body-portaled image/video carousel.
 * @param props.items - resolved media in carousel order.
 * @param props.labels - localized rail and viewer copy.
 * @param props.onRemove - optional mutable-draft removal callback.
 * @returns the rail and its selected fullscreen media, or nothing without items.
 */
export function FactoryMediaRail({ items, labels, onRemove }: {
  items: readonly FactoryPreviewMedia[]
  labels: FactoryMediaRailLabels
  onRemove?: (item: FactoryPreviewMedia) => void
}) {
  const [selectedId, setSelectedId] = useState<string>()
  useEffect(() => {
    if (selectedId !== undefined && !items.some(item => item.id === selectedId)) setSelectedId(undefined)
  }, [items, selectedId])
  const close = useCallback(() => { setSelectedId(undefined) }, [])

  if (items.length === 0) return null
  return (
    <>
      <AttachmentRail
        items={items}
        labels={{ group: labels.group, open: labels.open, scrollLeft: labels.scrollLeft, scrollRight: labels.scrollRight }}
        onOpen={item => { setSelectedId(item.id) }}
        {...(onRemove === undefined ? {} : { onRemove })}
      />
      {selectedId === undefined ? null : <FactoryMediaViewer items={items} selectedId={selectedId} labels={labels} onSelect={setSelectedId} onClose={close} />}
    </>
  )
}
