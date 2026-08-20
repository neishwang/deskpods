import type { DeskPodsApi } from '@types'

declare global {
  interface Window {
    deskpods: DeskPodsApi
  }
}
