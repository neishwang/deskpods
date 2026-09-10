import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer'),
      '@types': resolve('packages/types')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'packages/**/*.test.ts']
  }
})
