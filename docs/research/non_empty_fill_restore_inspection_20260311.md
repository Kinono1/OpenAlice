# Non-Empty Fill Restore Inspection

Date: `2026-03-11`

## Purpose

Verify TypeScript `PnLTracker` restore behavior against the real non-empty `pnl-fills.jsonl` file.

## Result

- fill count restored: `2`
- symbols seen in file: `WIF/USD`
- current allowedSymbols config: `BTC/USD`
- `symbolMismatchAgainstAllowedSymbols = true`
- `restoredSymbolOutsideAllowedList = true`

This proves the current `PnLTracker.restoreFromDisk()` logic does **not** silently drop fills just because the restored symbol is outside the current `allowedSymbols` list.

## Restored State

- restored flat position: `true`
- avgCost realized PnL: `-0.0001`
- FIFO realized PnL: `-0.0001`
- divergence: `0`
- reconciliation alert: `false`

## Conclusion

TypeScript restore succeeded on the real non-empty WIF fill file, and the symbol-mismatch concern did not reproduce.
