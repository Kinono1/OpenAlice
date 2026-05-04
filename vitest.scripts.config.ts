import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['scripts/**/*.spec.*'],
    exclude: ['**/*.e2e.spec.*', '**/node_modules/**'],
  },
})
