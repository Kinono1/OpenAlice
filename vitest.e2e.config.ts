import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Single process, sequential execution. E2E tests share stateful broker
// connections (IBKR TCP + clientId, REST API sessions). Module-level
// singletons in setup.ts require same-process to actually share state.
export default {
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['src/**/*.e2e.spec.*'],
    testTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
}
