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
        // Said out loud rather than left to the default: main stays CommonJS
        // because the preloads have to (see below), and `main` in package.json
        // points at `out/main/index.js`. An ESM build renames it to `.mjs`.
        output: { format: 'cjs' },
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
        // NOT negotiable: every preload here is loaded into a SANDBOXED web
        // contents, and a sandboxed preload is CommonJS in one file — it cannot
        // be an ES module, and it cannot `require` a shared chunk. An ESM build
        // would load none of them, and the bridge would simply not be there.
        output: { format: 'cjs' },
        input: {
          index: resolve('src/preload/index.ts'),
          pod: resolve('src/preload/pod.ts'),
          overlay: resolve('src/preload/overlay.ts')
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
