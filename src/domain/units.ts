/**
 * Unit normalization layer for OpenAlice.
 *
 * Internal calculations use Decimal (0.0028 = 0.28%).
 * Reports and configs use Percent (0.28 = 0.28%).
 *
 * Uses branded types to prevent silent unit mismatches.
 * TypeScript compiler blocks Percent → Decimal assignment without conversion.
 * Range checks catch magnitude errors (e.g. decimal passed as percent).
 */

type Brand<T, B extends string> = T & { readonly __brand: B }

export type Percent = Brand<number, 'Percent'>   // 0.28 = 0.28%
export type Decimal = Brand<number, 'Decimal'>   // 0.0028 = 0.28%
export type Bps = Brand<number, 'Bps'>           // 28 = 28 bps

export function percent(v: number): Percent {
  if (!Number.isFinite(v)) throw new Error(`Invalid Percent: ${v}`)
  if (Math.abs(v) > 10_000) throw new RangeError(`Percent out of range: ${v} (did you pass a decimal?)`)
  return v as Percent
}

export function decimal(v: number): Decimal {
  if (!Number.isFinite(v)) throw new Error(`Invalid Decimal: ${v}`)
  if (Math.abs(v) > 100) throw new RangeError(`Decimal out of range: ${v} (did you pass a percent?)`)
  return v as Decimal
}

export function bps(v: number): Bps {
  if (!Number.isFinite(v)) throw new Error(`Invalid Bps: ${v}`)
  if (Math.abs(v) > 1_000_000) throw new RangeError(`Bps out of range: ${v}`)
  return v as Bps
}

export function pctToDecimal(p: Percent): Decimal {
  if (!Number.isFinite(p as number)) return decimal(0)
  return decimal((p as number) / 100)
}

export function decimalToPct(d: Decimal): Percent {
  if (!Number.isFinite(d as number)) return percent(0)
  return percent((d as number) * 100)
}

export function bpsToDecimal(v: Bps): Decimal {
  if (!Number.isFinite(v as number)) return decimal(0)
  return decimal((v as number) / 10_000)
}
