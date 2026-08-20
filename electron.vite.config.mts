import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const types = resolve('packages/types')

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@types': types
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@types': types
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          pod: resolve('src/preload/pod.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@types': types
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('index.html'),
          overlay: resolve('overlay.html')
        }
      }
    }
  }
})
