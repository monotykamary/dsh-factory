import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChevronDown, Menu, Plus, Search, X } from '@monotykamary/dsh-client-ui-primitives'
import { TaskLabel } from './FactoryTaskVisuals.tsx'
import css from './FactoryApp.module.css'

const CREATE_LABEL = '__factory_create_label__'
const LABEL_PREFIX = '__factory_label__:'

/** Searchable task-label multi-select whose unmatched query can become a new label. */
export function FactoryLabelSelect({ selected, options, onChange }: {
  selected: readonly string[]
  options: readonly string[]
  onChange: (labels: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const available = useMemo(() => options.filter(label => !selectedSet.has(label)), [options, selectedSet])
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized === '' ? available : available.filter(label => label.toLowerCase().includes(normalized))
  }, [available, query])
  const candidate = query.trim()
  const canCreate = candidate !== '' && !options.some(label => label.toLowerCase() === candidate.toLowerCase())
    && !selected.some(label => label.toLowerCase() === candidate.toLowerCase())

  useEffect(() => { setHighlightedIndex(0) }, [query, filtered.length])
  useEffect(() => {
    if (!open) {
      setQuery('')
      setHighlightedIndex(0)
      return
    }
    requestAnimationFrame(() => { inputRef.current?.focus() })
  }, [open])

  const add = (label: string): void => {
    onChange([...selected, label])
    setQuery('')
    inputRef.current?.focus()
  }
  const choose = (id: string): void => {
    if (id === CREATE_LABEL) {
      if (canCreate) add(candidate)
      return
    }
    const label = id.slice(LABEL_PREFIX.length)
    if (!selectedSet.has(label)) add(label)
  }
  const remove = (label: string): void => { onChange(selected.filter(value => value !== label)) }
  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex(index => Math.min(filtered.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex(index => Math.max(0, index - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const label = filtered[highlightedIndex]
      if (label !== undefined) add(label)
      else if (canCreate) add(candidate)
    } else if (event.key === 'Backspace' && query === '' && selected.length > 0) {
      onChange(selected.slice(0, -1))
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <Menu
      open={open}
      portal
      compact
      className={css.labelSelectRoot!}
      onClose={() => { setOpen(false) }}
      onSelect={choose}
      items={[
        ...filtered.map((label, index) => ({
          id: `${LABEL_PREFIX}${label}`,
          label: <span className={css.labelSearchOption} data-highlighted={index === highlightedIndex || undefined} onPointerEnter={() => { setHighlightedIndex(index) }}><TaskLabel label={label} /></span>,
        })),
        ...(canCreate && filtered.length === 0 ? [{ id: CREATE_LABEL, icon: <Plus size={13} />, label: <span className={css.createLabelOption}>Create <strong>{candidate}</strong></span> }] : []),
      ]}
      {...(canCreate && filtered.length > 0 ? { footer: [{ id: CREATE_LABEL, icon: <Plus size={13} />, label: <span className={css.createLabelOption}>Create <strong>{candidate}</strong></span> }] } : {})}
      header={(
        <div className={css.labelSearchSurface}>
          <label className={css.selectSearchHeader}>
            <Search size={13} aria-hidden="true" />
            <input ref={inputRef} type="search" aria-label="Search or create labels" value={query} placeholder="Search or create a label…" onChange={event => { setQuery(event.target.value) }} onKeyDown={handleSearchKey} />
          </label>
          {filtered.length === 0 && !canCreate ? <span className={css.selectSearchEmpty}>{available.length === 0 ? 'All labels selected.' : 'No labels match your search.'}</span> : null}
        </div>
      )}
      anchor={(
        <div
          role="combobox"
          aria-label="Task labels"
          aria-haspopup="menu"
          aria-expanded={open}
          tabIndex={0}
          className={css.labelSelectTrigger}
          onClick={() => { setOpen(true) }}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(true) } }}
        >
          <span className={css.labelSelectValues}>
            {selected.length === 0 ? <span className={css.propertyEmpty}>Add labels…</span> : selected.map(label => (
              <span className={css.labelSelectChip} key={label}>
                <TaskLabel label={label} />
                <button type="button" aria-label={`Remove ${label}`} onClick={event => { event.stopPropagation(); remove(label) }}><X size={11} /></button>
              </span>
            ))}
          </span>
          <ChevronDown size={13} className={open ? css.selectMenuChevronOpen : css.selectMenuChevron} />
        </div>
      )}
    />
  )
}
