import type { IMarketDataProvider } from "../data/interfaces.js";

export interface KlineStore {
  marketDataProvider: IMarketDataProvider;
  getPlayheadTime(): Date;
  calculatePreviousTime(lookbackBars: number): Date;
  getAvailableSymbols(): string[];
}
