// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskLabels } from '../src/client/FactoryTaskVisuals.tsx'

afterEach(cleanup)

describe('TaskLabels degraded fallback', () => {
  it('renders an empty container without labels', () => {
    const { container } = render(<TaskLabels labels={[]} />)
    expect(container.firstElementChild?.childElementCount).toBe(0)
  })

  // jsdom has no canvas text measurement, so the flow degrades to showing every pill unmeasured.
  it('shows all labels unmeasured when canvas measurement is unavailable', async () => {
    const { findByText } = render(<TaskLabels labels={['alpha', 'beta', 'gamma', 'delta']} />)
    for (const label of ['alpha', 'beta', 'gamma', 'delta']) {
      await findByText(label)
    }
  })
})
