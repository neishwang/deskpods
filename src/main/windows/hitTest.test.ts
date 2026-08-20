import { describe, expect, it } from 'vitest'
import { isInsideAreas } from './hitTest'

// The two toasts measured by the overlay in a 986px-wide content area.
const TOASTS = [
  { x: 654, y: 12, width: 320, height: 73 },
  { x: 654, y: 95, width: 320, height: 54 }
]

describe('isInsideAreas', () => {
  it('catches a point inside a region', () => {
    expect(isInsideAreas(TOASTS, 814, 49)).toBe(true)
    expect(isInsideAreas(TOASTS, 814, 120)).toBe(true)
  })

  it('ignores the gap between two stacked toasts', () => {
    expect(isInsideAreas(TOASTS, 814, 90)).toBe(false)
  })

  it('ignores the page around them', () => {
    expect(isInsideAreas(TOASTS, 100, 40)).toBe(false)
    expect(isInsideAreas(TOASTS, 814, 400)).toBe(false)
    expect(isInsideAreas(TOASTS, 653, 40)).toBe(false)
  })

  it('includes the edges', () => {
    expect(isInsideAreas(TOASTS, 654, 12)).toBe(true)
    expect(isInsideAreas(TOASTS, 974, 85)).toBe(true)
    expect(isInsideAreas(TOASTS, 975, 85)).toBe(false)
  })

  it('is false when nothing is clickable', () => {
    expect(isInsideAreas([], 814, 49)).toBe(false)
  })
})
