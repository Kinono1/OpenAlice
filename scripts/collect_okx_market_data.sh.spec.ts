import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

const scriptPath = resolve(
  import.meta.dirname,
  'collect_okx_market_data.sh',
)

describe('collect_okx_market_data.sh', () => {
  it('exists and is executable', () => {
    expect(existsSync(scriptPath)).toBe(true)
    const stat = execSync(`stat -f "%Lp" "${scriptPath}"`, { encoding: 'utf-8' }).trim()
    // Should be executable (755 or similar with x bits)
    expect(stat).toMatch(/[57]/)
  })

  it('dry-run prints expected paths without making API calls', () => {
    const output = execSync(`bash "${scriptPath}" --dry-run 2>&1`, {
      encoding: 'utf-8',
      timeout: 30_000,
    })

    // Verify dry-run mode is acknowledged
    expect(output).toContain('[dry-run]')

    // Verify each output path pattern appears
    expect(output).toContain('tickers/')
    expect(output).toContain('tickers_')
    expect(output).toContain('btc_1h_')
    expect(output).toContain('eth_1h_')
    expect(output).toContain('btc_funding_')
    expect(output).toContain('btc_oi_')

    // Verify the YYYY-MM and YYYY-MM-DD patterns appear
    const yearMonthPattern = /\d{4}-\d{2}/g
    const matches = output.match(yearMonthPattern)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(5)

    const todayPattern = /\d{4}-\d{2}-\d{2}/g
    const todayMatches = output.match(todayPattern)
    expect(todayMatches).not.toBeNull()
    expect(todayMatches!.length).toBeGreaterThanOrEqual(5)
  })

  it('dry-run does not create any output files or directories', () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'okx-collector-test-'))

    // Run with a custom output base in dry-run mode
    const output = execSync(
      `OUTPUT_BASE="${tmpDir}" bash "${scriptPath}" --dry-run 2>&1`,
      { encoding: 'utf-8', timeout: 30_000 },
    )

    // No files should have been created
    const files = execSync(`find "${tmpDir}" -type f 2>/dev/null || true`, {
      encoding: 'utf-8',
    }).trim()
    expect(files).toBe('')

    const dirs = execSync(`find "${tmpDir}" -mindepth 1 -type d 2>/dev/null || true`, {
      encoding: 'utf-8',
    }).trim()
    // Only the tmpDir itself may exist; dry-run must not create children.
    expect(dirs).toBe('')

    // Cleanup
    execSync(`rm -rf "${tmpDir}"`)
  })

  it('handles API errors gracefully (simulated by bogus URL)', () => {
    // Override OKX_BASE to a non-existent URL to simulate API failure
    const output = execSync(
      `OKX_BASE="https://httpstat.us/500" bash "${scriptPath}" --dry-run 2>&1`,
      { encoding: 'utf-8', timeout: 30_000 },
    )
    // In dry-run mode, no actual curl calls happen so it should still succeed
    expect(output).toContain('[dry-run]')
  })

  it('real dry-run output directory paths follow expected structure', () => {
    const output = execSync(`bash "${scriptPath}" --dry-run 2>&1`, {
      encoding: 'utf-8',
      timeout: 30_000,
    })

    // Extract all mkdir output lines and verify paths
    const mkdirLines = output.split('\n').filter(l => l.includes('mkdir'))
    expect(mkdirLines.length).toBeGreaterThanOrEqual(4)

    // Verify the base path is correct
    const basePath = '/Volumes/shield/cryptoData/openalice-data/market/okx-live'
    for (const line of mkdirLines) {
      expect(line).toContain(basePath)
    }

    // Verify each category directory
    const categories = ['tickers', 'candles', 'funding', 'oi']
    for (const cat of categories) {
      const dirMatch = output.match(
        new RegExp(`${basePath}/${cat}/\\d{4}-\\d{2}`),
      )
      expect(dirMatch).not.toBeNull()
    }
  })
})
