import { measureNaturalWidth, prepareWithSegments } from '@chenglou/pretext'

export type TextMeasure = (text: string) => number

/**
 * Canvas-grounded single-line text measure with per-string caching, powered by pretext.
 * Probes the canvas eagerly and throws when DOM text measurement is unavailable
 * (e.g. jsdom), so callers can degrade to unmeasured CSS flow.
 */
export function createPretextTextMeasure(font: string, letterSpacing = 0): TextMeasure {
  const cache = new Map<string, number>()
  const measure: TextMeasure = (text) => {
    const cached = cache.get(text)
    if (cached !== undefined) return cached
    const width = measureNaturalWidth(prepareWithSegments(text, font, { letterSpacing }))
    cache.set(text, width)
    return width
  }
  measure('Ag…-+10')
  return measure
}
