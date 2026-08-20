import type { Rect } from '@types'

/**
 * Whether a point falls inside one of the regions, both expressed in the
 * overlay window's own coordinates. Bounds are inclusive: the cursor sitting
 * exactly on a toast's last pixel row still counts as being on it.
 */
export function isInsideAreas(areas: Rect[], x: number, y: number): boolean {
  return areas.some((a) => x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height)
}
