import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { ChevronDown, Menu, Search } from '@monotykamary/dsh-client-ui-primitives'
import css from './FactoryApp.module.css'

export interface FactorySelectOption {
  id: string
  label: string
  icon?: ReactNode
  disabled?: boolean
}

export interface FactorySelectSearch {
  placeholder: string
  emptyLabel: string
  ariaLabel: string
}

/** DSH Menu-backed select trigger with optional Localterm-style search and keyboard selection. */
export function FactorySelectMenu({ value, values, items, placeholder, ariaLabel, disabled = false, closeOnSelect = true, search, onSelect }: {
  value?: string | undefined
  values?: readonly string[] | undefined
  items: readonly FactorySelectOption[]
  placeholder: string
  ariaLabel: string
  disabled?: boolean
  closeOnSelect?: boolean
  search?: FactorySelectSearch | undefined
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const selected = value === undefined ? undefined : items.find(item => item.id === value)
  const multipleLabel = values === undefined || values.length === 0
    ? undefined
    : values.length === 1 ? items.find(item => item.id === values[0])?.label : `${String(values.length)} selected`
  const label = selected?.label ?? multipleLabel ?? placeholder
  const icon = selected?.icon
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized === '' ? items : items.filter(item => item.label.toLowerCase().includes(normalized))
  }, [items, query])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setHighlightedIndex(0)
      return
    }
    if (search !== undefined) requestAnimationFrame(() => { inputRef.current?.focus() })
  }, [open, search])

  useEffect(() => { setHighlightedIndex(0) }, [query, filtered.length])

  const choose = (id: string): void => {
    onSelect(id)
    if (closeOnSelect) setOpen(false)
  }
  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex(index => Math.min(filtered.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex(index => Math.max(0, index - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = filtered[highlightedIndex]
      if (item !== undefined && item.disabled !== true) choose(item.id)
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  const menuItems = filtered.map((item, index) => ({
    id: item.id,
    label: search === undefined
      ? item.label
      : <span className={css.selectSearchOption} data-highlighted={index === highlightedIndex || undefined} onPointerEnter={() => { setHighlightedIndex(index) }}>{item.label}</span>,
    ...(item.icon === undefined ? {} : { icon: item.icon }),
    ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
  }))
  const header = search === undefined ? undefined : (
    <div className={css.selectSearchSurface}>
      <label className={css.selectSearchHeader}>
        <Search size={13} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          aria-label={search.ariaLabel}
          value={query}
          placeholder={search.placeholder}
          onChange={event => { setQuery(event.target.value) }}
          onKeyDown={handleSearchKey}
        />
      </label>
      {filtered.length === 0 ? <span className={css.selectSearchEmpty}>{search.emptyLabel}</span> : null}
    </div>
  )

  return (
    <Menu
      open={open}
      portal
      compact
      className={css.selectMenuRoot!}
      selectedId={value}
      selectedIds={values}
      header={header}
      onClose={() => { setOpen(false) }}
      onSelect={choose}
      items={menuItems}
      anchor={(
        <button
          type="button"
          className={css.selectMenuTrigger}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setOpen(valueOpen => !valueOpen) }}
        >
          {icon === undefined ? null : <span className={css.selectMenuIcon}>{icon}</span>}
          <span>{label}</span>
          <ChevronDown size={13} className={open ? css.selectMenuChevronOpen : css.selectMenuChevron} />
        </button>
      )}
    />
  )
}
