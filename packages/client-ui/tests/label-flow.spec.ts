import { describe, expect, it } from 'vitest'
import { planLabelFlow, truncateLabelText, type FlowLabelEntry } from '../src/client/label-flow.ts'

const CHROME = 29
const GAP = 4
const OVERFLOW = 30
const entry = (label: string, textWidth: number): FlowLabelEntry => ({ label, text: label, width: textWidth + CHROME })
const overflowWidth = (hidden: number): number => OVERFLOW + hidden * 0

/** Deterministic fake measure: every grapheme, including the ellipsis, is COLUMNS px wide. */
const charMeasure = (columns: number) => (value: string): number => [...value].length * columns

describe('planLabelFlow', () => {
  it('renders nothing for an empty label list', () => {
    expect(planLabelFlow([], 200, GAP, overflowWidth)).toEqual({ visible: [], hidden: [] })
  })

  it('keeps every pill at natural width when all of them fit', () => {
    const entries = [entry('alpha', 50), entry('beta', 50), entry('gamma', 50)]
    const total = 79 * 3 + GAP * 2
    const plan = planLabelFlow(entries, total, GAP, overflowWidth)
    expect(plan.visible).toEqual(entries)
    expect(plan.hidden).toEqual([])
  })

  it('shows only whole pills and reserves space for the overflow counter', () => {
    const entries = [entry('alpha', 70), entry('beta', 70), entry('gamma', 70)]
    const plan = planLabelFlow(entries, 140, GAP, overflowWidth)
    expect(plan.visible.map(item => item.label)).toEqual(['alpha'])
    expect(plan.hidden).toEqual(['beta', 'gamma'])
  })

  it('squeezes a truncated first pill before degrading to the bare counter', () => {
    const entries = [entry('alpha', 70), entry('beta', 70), entry('gamma', 70)]
    const plan = planLabelFlow(entries, 120, GAP, overflowWidth, (item, maxWidth) => {
      if (maxWidth < CHROME + 20) return null
      return { ...item, text: 'alp…', width: maxWidth }
    })
    expect(plan.visible.map(item => item.text)).toEqual(['alp…'])
    expect(plan.hidden).toEqual(['beta', 'gamma'])
  })

  it('falls back to the counter alone when nothing else can fit', () => {
    const entries = [entry('alpha', 70), entry('beta', 70)]
    const plan = planLabelFlow(entries, 50, GAP, overflowWidth, () => null)
    expect(plan.visible).toEqual([])
    expect(plan.hidden).toEqual(['alpha', 'beta'])
  })
})

describe('truncateLabelText', () => {
  const measure = charMeasure(10)

  it('returns labels that already fit untouched', () => {
    expect(truncateLabelText('alpha', 100, measure)).toEqual({ text: 'alpha', width: 50 })
  })

  it('prefers cutting at a delimiter instead of mid-word', () => {
    // 13 chars fit, but snapping to the dash yields skill-mining… over skill-mining-…
    expect(truncateLabelText('skill-mining-archive', 140, measure)).toEqual({ text: 'skill-mining…', width: 130 })
  })

  it('snaps to camelCase boundaries for concatenated names', () => {
    expect(truncateLabelText('openWebUiShell', 90, measure)).toEqual({ text: 'openWeb…', width: 80 })
  })

  it('falls back to a grapheme cut when no boundary exists in range', () => {
    expect(truncateLabelText('abcdefghij', 50, measure)).toEqual({ text: 'abcd…', width: 50 })
  })

  it('ignores boundaries that would drop more than half the fitting text', () => {
    // Dash sits before the midpoint floor, so the denser mid-word cut wins
    expect(truncateLabelText('a-verylongthinghere', 130, measure)).toEqual({ text: 'a-verylongth…', width: 130 })
  })

  it('returns null when not even one grapheme plus the ellipsis fits', () => {
    expect(truncateLabelText('abcdefgh', 15, measure)).toBeNull()
  })
})
