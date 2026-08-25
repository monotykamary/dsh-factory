export interface FlowLabelEntry {
  /** Untruncated label text, used for identity, dot tone, and tooltips. */
  label: string
  /** Text rendered inside the pill, already truncated when needed. */
  text: string
  /** Full pill width in px, including padding, border, and dot chrome. */
  width: number
}

export interface LabelFlowPlan {
  visible: readonly FlowLabelEntry[]
  hidden: readonly string[]
}

/** Horizontal gap between pills, mirroring the .taskLabels flex gap. */
export const LABEL_GAP_PX = 4
/** Pill chrome around measured text: 7px padding on both sides, 1px border on both sides, 7px dot + 6px dot gap. */
export const LABEL_PILL_CHROME_PX = 29
/** Overflow pill chrome: padding and border only, no dot. */
export const LABEL_OVERFLOW_CHROME_PX = 16
/** Absolute per-pill text cap so one long label can never eat a row on its own. */
export const LABEL_TEXT_CAP_PX = 180
/** Smallest text width a truncated first pill may occupy before falling back to counter-only. */
export const LABEL_TEXT_FLOOR_PX = 32

type OverflowWidth = (hiddenCount: number) => number
type FitWithin = (entry: FlowLabelEntry, maxWidth: number) => FlowLabelEntry | null

/**
 * Decide how many natural-width pills fit one row without ever clipping a pill mid-word.
 * Hidden labels collapse into a `+N` counter whose width is reserved while fitting.
 */
export function planLabelFlow(
  entries: readonly FlowLabelEntry[],
  availableWidth: number,
  gap: number,
  overflowWidth: OverflowWidth,
  fitWithin?: FitWithin,
): LabelFlowPlan {
  const labels = entries.map(entry => entry.label)
  if (entries.length === 0) return { visible: [], hidden: [] }
  if (!(availableWidth > 0)) return { visible: [], hidden: labels }
  const natural = entries.reduce((sum, entry) => sum + entry.width, 0) + gap * (entries.length - 1)
  if (natural <= availableWidth) return { visible: entries, hidden: [] }

  let shown = 0
  let used = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const next = used + (shown === 0 ? 0 : gap) + entry.width
    const remaining = entries.length - index - 1
    const reserve = remaining === 0 ? 0 : gap + overflowWidth(remaining)
    if (next + reserve <= availableWidth) {
      shown += 1
      used = next
    } else break
  }
  if (shown > 0) return { visible: entries.slice(0, shown), hidden: labels.slice(shown) }

  // Nothing fits whole: squeeze the first label before degrading to a bare counter.
  if (fitWithin !== undefined) {
    const counter = overflowWidth(labels.length)
    const candidate = fitWithin(entries[0]!, availableWidth - gap - counter)
    if (candidate !== null && candidate.width + gap + counter <= availableWidth + 0.5) {
      return { visible: [candidate], hidden: labels.slice(1) }
    }
  }
  return { visible: [], hidden: labels }
}

const TRUNCATION_DELIMITERS = new Set(['-', '_', '.', '/', ':', ' '])
const LOWER_LETTER = /\p{Ll}/u
const UPPER_LETTER = /\p{Lu}/u

/**
 * Fit one label into `maxWidth`, appending an ellipsis when truncation is required.
 * Cuts prefer the last delimiter or camelCase boundary beyond the midpoint of the
 * fitting prefix, so `skill-mining-archive` becomes `skill-mining…` rather than `skill-mining-arch…`.
 * Returns null when even one grapheme plus the ellipsis exceeds the budget.
 */
export function truncateLabelText(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
): { text: string; width: number } | null {
  const full = measure(text)
  if (full <= maxWidth) return { text, width: full }
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment)
  let low = 1
  let high = graphemes.length - 1
  let best = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (measure(graphemes.slice(0, mid).join('') + '…') <= maxWidth) {
      best = mid
      low = mid + 1
    } else high = mid - 1
  }
  if (best === 0) return null

  let cut = best
  const floor = Math.max(1, Math.ceil(best / 2))
  for (let index = best - 1; index >= floor; index -= 1) {
    const at = graphemes[index]!
    const before = graphemes[index - 1]!
    if (TRUNCATION_DELIMITERS.has(at) || (UPPER_LETTER.test(at) && LOWER_LETTER.test(before))) {
      cut = index
      break
    }
  }
  const truncated = graphemes.slice(0, cut).join('') + '…'
  return { text: truncated, width: measure(truncated) }
}
