export function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

export function readNumber(
  value: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate
    }
    if (typeof candidate === 'string') {
      const parsed = Number(candidate)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }
  return undefined
}

export function readTimestamp(
  value: Record<string, unknown>,
  keys: string[] = ['timestamp'],
): number | undefined {
  return readNumber(value, keys)
}

export function extractOpenInterestNumbers(payload: unknown): {
  openInterest?: number
  openInterestValue?: number
  timestamp?: number
} {
  const record = toRecord(payload)
  return {
    openInterest: readNumber(record, [
      'openInterestAmount',
      'openInterest',
      'amount',
      'contracts',
    ]),
    openInterestValue: readNumber(record, [
      'openInterestValue',
      'notionalValue',
      'value',
      'notional',
    ]),
    timestamp: readTimestamp(record),
  }
}

export function extractLiquidationNumbers(payload: unknown): {
  contracts?: number
  price?: number
  timestamp?: number
} {
  const record = toRecord(payload)
  return {
    contracts: readNumber(record, [
      'contracts',
      'amount',
      'filled',
      'quantity',
    ]),
    price: readNumber(record, [
      'price',
      'average',
      'avgPrice',
    ]),
    timestamp: readTimestamp(record),
  }
}
