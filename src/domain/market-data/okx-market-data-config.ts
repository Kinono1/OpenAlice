import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

const DEFAULT_FIXED = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'] as const

const schema = z.object({
  enabled: z.boolean().default(false),
  mode: z.literal('research_only').default('research_only'),
  dataRoot: z.string().default('data'),
  warehouseRelativeRoot: z.string().default('warehouse/okx'),
  storage: z.object({
    budgetGiB: z.literal(30).default(30),
    freeSpaceFloorGiB: z.literal(20).default(20),
    warningFreeSpaceGiB: z.literal(25).default(25),
    pauseHighFrequencyAtGiB: z.literal(28).default(28),
    resumeHighFrequencyBelowGiB: z.literal(26).default(26),
    pauseBroadCollectionFreeSpaceGiB: z.literal(15).default(15),
    emergencyStopFreeSpaceGiB: z.literal(10).default(10),
    hotHighFrequencyRetentionDays: z.literal(7).default(7),
  }).default({
    budgetGiB: 30, freeSpaceFloorGiB: 20, warningFreeSpaceGiB: 25,
    pauseHighFrequencyAtGiB: 28, resumeHighFrequencyBelowGiB: 26,
    pauseBroadCollectionFreeSpaceGiB: 15, emergencyStopFreeSpaceGiB: 10,
    hotHighFrequencyRetentionDays: 7,
  }),
  universe: z.object({
    fixedDeepInstruments: z.array(z.string()).default([...DEFAULT_FIXED]),
    dynamicDepthCount: z.literal(10).default(10),
    topMinuteCandleCount: z.literal(50).default(50),
    maxDailyDepthChanges: z.literal(3).default(3),
    challengerImprovementPct: z.literal(10).default(10),
    maxSpreadBps: z.literal(50).default(50),
  }).default({
    fixedDeepInstruments: [...DEFAULT_FIXED], dynamicDepthCount: 10,
    topMinuteCandleCount: 50, maxDailyDepthChanges: 3,
    challengerImprovementPct: 10, maxSpreadBps: 50,
  }),
  publicMarkets: z.object({
    instruments: z.array(z.enum(['SPOT', 'SWAP', 'FUTURES', 'OPTION'])).default(['SPOT', 'SWAP', 'FUTURES', 'OPTION']),
    tickers: z.array(z.enum(['SPOT', 'SWAP', 'FUTURES'])).default(['SPOT', 'SWAP', 'FUTURES']),
    broadCandles: z.array(z.enum(['SPOT', 'SWAP'])).default(['SPOT', 'SWAP']),
  }).default({ instruments: ['SPOT', 'SWAP', 'FUTURES', 'OPTION'], tickers: ['SPOT', 'SWAP', 'FUTURES'], broadCandles: ['SPOT', 'SWAP'] }),
  stream: z.object({
    enabled: z.boolean().default(false),
    publicUrl: z.string().default('wss://ws.okx.com:8443/ws/v5/public'),
    businessUrl: z.string().default('wss://ws.okx.com:8443/ws/v5/business'),
    fullDepthEnabled: z.boolean().default(false),
    fullDepthMode: z.enum(['canary_btc', 'continuous', 'bounded_capture_window', 'disabled']).default('disabled'),
  }).default({
    enabled: false, publicUrl: 'wss://ws.okx.com:8443/ws/v5/public',
    businessUrl: 'wss://ws.okx.com:8443/ws/v5/business', fullDepthEnabled: false,
    fullDepthMode: 'disabled',
  }),
  archive: z.object({
    enabled: z.boolean().default(true),
    enrollmentPath: z.string().default('data/config/okx-archive-storage.json'),
    expectedName: z.literal('shield').default('shield'),
    archiveRelativeRoot: z.string().default('cryptoData/openalice-data/warehouse/okx'),
    warnUsedPct: z.literal(85).default(85),
    pauseArchiveUsedPct: z.literal(92).default(92),
    automaticDeletion: z.literal(false).default(false),
  }).default({
    enabled: true, enrollmentPath: 'data/config/okx-archive-storage.json', expectedName: 'shield',
    archiveRelativeRoot: 'cryptoData/openalice-data/warehouse/okx', warnUsedPct: 85,
    pauseArchiveUsedPct: 92, automaticDeletion: false,
  }),
  privateDataEnabled: z.literal(false).default(false),
  marginDataEnabled: z.literal(false).default(false),
  optionChainEnabled: z.literal(false).default(false),
}).strict()

export type OkxMarketDataConfig = z.infer<typeof schema>

export function defaultOkxMarketDataConfig(): OkxMarketDataConfig {
  return schema.parse({})
}

export async function loadOkxMarketDataConfig(path = 'data/config/okx-market-data.json'): Promise<OkxMarketDataConfig> {
  try {
    const parsed = schema.parse(JSON.parse(await readFile(resolve(path), 'utf-8')))
    if (parsed.privateDataEnabled || parsed.marginDataEnabled || parsed.optionChainEnabled) {
      throw new Error('OKX warehouse v1 rejects private, margin, and option-chain collection')
    }
    if (resolve(parsed.dataRoot).startsWith('/Volumes/')) {
      throw new Error('active OKX warehouse dataRoot must remain local; /Volumes is cold-storage only')
    }
    return parsed
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultOkxMarketDataConfig()
    }
    throw error
  }
}

export function resolveOkxWarehouseRoot(config: OkxMarketDataConfig): string {
  return resolve(config.dataRoot, config.warehouseRelativeRoot)
}

export { schema as okxMarketDataConfigSchema }
