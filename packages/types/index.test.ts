import { describe, expect, it } from 'vitest'
import { IpcChannels } from './index'

describe('IpcChannels', () => {
  it('exposes stable, namespaced channel names', () => {
    expect(IpcChannels.getState).toBe('app:getState')
    expect(IpcChannels.createPod).toBe('pods:create')
    expect(IpcChannels.updateBounds).toBe('pods:updateBounds')
  })

  it('has no duplicate channel values', () => {
    const values = Object.values(IpcChannels)
    expect(new Set(values).size).toBe(values.length)
  })
})
