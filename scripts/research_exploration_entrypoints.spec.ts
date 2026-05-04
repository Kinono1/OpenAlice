import { describe, expect, it } from 'vitest'
import { parseArgs as parseBtcNativeManifestV2Args } from './materialize_openalice_native_btc_manifest_v2.ts'
import { parseArgs as parseBtcNativeManifestV3Args } from './materialize_openalice_native_btc_manifest_v3.ts'
import { parseArgs as parseCrossSectionalMonteCarloArgs } from './run_cross_sectional_monte_carlo.ts'
import { parseArgs as parseTimeframeSweepArgs } from './sweep_all_timeframes.ts'

describe('research exploration entrypoint safety', () => {
  it('defaults remaining research exploration entrypoints to dry-run', () => {
    expect(parseBtcNativeManifestV2Args([]).dryRun).toBe(true)
    expect(parseBtcNativeManifestV3Args([]).dryRun).toBe(true)
    expect(parseCrossSectionalMonteCarloArgs([]).dryRun).toBe(true)
    expect(parseTimeframeSweepArgs([]).dryRun).toBe(true)
  })

  it('requires explicit opt-in before materializing manifests or running exploratory analysis', () => {
    expect(parseBtcNativeManifestV2Args(['--dryRun', 'false']).dryRun).toBe(false)
    expect(parseBtcNativeManifestV3Args(['--dryRun=false']).dryRun).toBe(false)
    expect(parseCrossSectionalMonteCarloArgs(['--dryRun', 'false']).dryRun).toBe(false)
    expect(parseTimeframeSweepArgs(['--dryRun=false']).dryRun).toBe(false)
  })

  it('preserves custom manifest outputs in dry-run mode', () => {
    expect(parseBtcNativeManifestV3Args([
      '--output',
      'tmp/manifest.json',
      '--canonical-manifest-path',
      'tmp/canonical.latest.json',
    ])).toMatchObject({
      dryRun: true,
      output: 'tmp/manifest.json',
      canonicalManifestPath: 'tmp/canonical.latest.json',
    })
  })
})
