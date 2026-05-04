import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs as parseBtcNativeManifestArgs } from './materialize_openalice_native_btc_manifest.ts'
import { parseArgs as parseEthBtcRelativeValueArgs } from './run_eth_btc_relative_value_validation.ts'
import { parseArgs as parseFactorShockFadeArgs } from './run_factor_shock_fade_validation.ts'

function runPythonEntrypoint(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('python3', ['scripts/scan_cointegration_pairs.py', ...args], {
      cwd: resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('close', code => {
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
    child.on('error', reject)
  })
}

describe('standalone research entrypoint safety', () => {
  it('defaults artifact-producing TypeScript entrypoints to dry-run', () => {
    expect(parseEthBtcRelativeValueArgs([]).dryRun).toBe(true)
    expect(parseFactorShockFadeArgs([]).dryRun).toBe(true)
    expect(parseBtcNativeManifestArgs([]).dryRun).toBe(true)
  })

  it('requires explicit opt-in before writing TypeScript validation or manifest artifacts', () => {
    expect(parseEthBtcRelativeValueArgs(['--dryRun', 'false']).dryRun).toBe(false)
    expect(parseFactorShockFadeArgs(['--dryRun=false']).dryRun).toBe(false)
    expect(parseBtcNativeManifestArgs(['--dryRun', 'false']).dryRun).toBe(false)
  })

  it('defaults the cointegration scanner to dry-run before reading klines or writing registry', async () => {
    const result = await runPythonEntrypoint([])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const payload = JSON.parse(result.stdout) as {
      executionMode: {
        dryRun: boolean
        writesPairsRegistry: boolean
      }
      optIn: {
        scanAndWriteRegistry: string
      }
    }
    expect(payload.executionMode).toMatchObject({
      dryRun: true,
      writesPairsRegistry: false,
    })
    expect(payload.optIn.scanAndWriteRegistry).toBe('--dry-run false')
  })
})
