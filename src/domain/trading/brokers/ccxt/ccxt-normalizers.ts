function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
}

function toFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() === ''
    ? Number.NaN
    : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function readFirstFiniteNumber(
  payload: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const direct = toFiniteNumber(payload[key])
    if (direct != null) {
      return direct
    }

    const nested = asRecord(payload.info)
    const nestedValue = toFiniteNumber(nested[key])
    if (nestedValue != null) {
      return nestedValue
    }
  }
  return undefined
}

function readTimestamp(payload: Record<string, unknown>): number | undefined {
  const timestamp = readFirstFiniteNumber(payload, ['timestamp'])
  if (timestamp != null) {
    return timestamp
  }

  const datetime = payload.datetime
  if (typeof datetime === 'string' && datetime.trim()) {
    const parsed = Date.parse(datetime)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  const info = asRecord(payload.info)
  const infoDatetime = info.datetime
  if (typeof infoDatetime === 'string' && infoDatetime.trim()) {
    const parsed = Date.parse(infoDatetime)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

export function normalizeOpenInterestPayload(payload: unknown): {
  openInterest: number
  openInterestValue?: number
  timestamp?: number
} {
  const record = asRecord(payload)
  return {
    openInterest:
      readFirstFiniteNumber(record, [
        'openInterest',
        'openInterestAmount',
        'amount',
        'contracts',
      ]) ?? 0,
    openInterestValue:
      readFirstFiniteNumber(record, [
        'openInterestValue',
        'notionalValue',
        'quoteValue',
        'value',
      ]),
    timestamp: readTimestamp(record),
  }
}

export interface NormalizedLiquidationRow {
  contracts: number
  price: number
  notional?: number
  timestamp?: number
}

export function normalizeLiquidationRows(
  rows: unknown[] | null | undefined,
): NormalizedLiquidationRow[] {
  return (rows ?? []).map((row) => {
    const record = asRecord(row)
    const contracts =
      readFirstFiniteNumber(record, [
        'contracts',
        'amount',
        'filled',
        'baseValue',
      ]) ?? 0
    const price = readFirstFiniteNumber(record, ['price', 'average', 'avgPrice']) ?? 0
    const explicitNotional = readFirstFiniteNumber(record, [
      'quoteValue',
      'cost',
      'notionalValue',
      'value',
    ])
    const resolvedNotional =
      explicitNotional != null
        ? explicitNotional
        : Number.isFinite(contracts) && Number.isFinite(price)
          ? contracts * price
          : undefined

    return {
      contracts,
      price,
      notional:
        resolvedNotional != null && Number.isFinite(resolvedNotional) && resolvedNotional > 0
          ? resolvedNotional
          : undefined,
      timestamp: readTimestamp(record),
    }
  })
}

export function summarizeLiquidationRows(
  rows: unknown[] | null | undefined,
): {
  count: number
  totalContracts: number
  totalNotional?: number
  latestTimestamp?: number
} {
  let totalContracts = 0
  let totalNotional = 0
  let latestTimestamp = 0

  for (const normalized of normalizeLiquidationRows(rows)) {
    const contracts = normalized.contracts
    if (Number.isFinite(contracts)) {
      totalContracts += contracts
    }

    if (normalized.notional != null) {
      totalNotional += normalized.notional
    }
    const timestamp = normalized.timestamp ?? 0
    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp
    }
  }

  return {
    count: rows?.length ?? 0,
    totalContracts,
    totalNotional: totalNotional > 0 ? totalNotional : undefined,
    latestTimestamp: latestTimestamp > 0 ? latestTimestamp : undefined,
  }
}
