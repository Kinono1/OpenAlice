import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { loadOkxMarketDataConfig } from './okx-market-data-config.js'

export class OkxStreamSupervisor {
  private child: ChildProcess | null = null
  private stopped = false
  private restartTimer: NodeJS.Timeout | null = null
  private attempts = 0
  private leasePath: string | null = null

  async start(): Promise<void> {
    const config = await loadOkxMarketDataConfig()
    if (!config.stream.enabled) return
    this.leasePath = resolve(config.dataRoot, 'runtime', 'locks', 'okx_stream_worker.lease.json')
    this.stopped = false
    await this.spawnWorker()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.child?.kill('SIGTERM')
    this.child = null
    if (this.leasePath) await rm(this.leasePath, { force: true })
  }

  private async spawnWorker(): Promise<void> {
    if (this.stopped || this.child) return
    if (!this.leasePath) throw new Error('okx-stream: lease path is not initialized')
    if (await leaseOwnerAlive(this.leasePath)) {
      console.warn('okx-stream: live worker lease exists; supervisor will not start a duplicate')
      return
    }
    const tsx = resolve('node_modules/.bin/tsx')
    const script = resolve('scripts/run_okx_stream_worker.ts')
    const child = spawn(tsx, [script], { cwd: resolve('.'), stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
    this.child = child
    const leasePath = this.leasePath
    await mkdir(dirname(leasePath), { recursive: true })
    await writeFile(leasePath, `${JSON.stringify({ pid: child.pid ?? null, parentPid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
    child.once('exit', () => {
      this.child = null
      rm(leasePath, { force: true }).catch(() => {})
      if (this.stopped) return
      this.attempts += 1
      const delay = Math.min(60_000, [1_000, 2_000, 5_000, 10_000, 30_000, 60_000][Math.min(this.attempts - 1, 5)])
      const jitter = Math.floor(Math.random() * Math.max(250, delay * 0.2))
      this.restartTimer = setTimeout(() => { this.spawnWorker().catch(error => console.warn('okx-stream: restart failed', error)) }, delay + jitter)
    })
  }
}

async function leaseOwnerAlive(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, 'utf-8')) as { pid?: number }
    if (!Number.isInteger(value.pid)) return false
    process.kill(value.pid!, 0)
    return true
  } catch { return false }
}
