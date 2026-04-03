import type {
  IMarketDataProvider,
  MarketData,
  NewsItem,
} from "../analysis-kit/data/interfaces.js";

export interface IAnalysisContext {
  getPlayheadTime(): Date;
  getLatestOHLCV(symbol: string, lookback?: number): Promise<MarketData[]>;
  getNewsV2(params: {
    symbol?: string;
    lookback?: number;
    lookbackHours?: number;
    limit?: number;
  }): Promise<NewsItem[]>;
  getAvailableSymbols(): string[];
  calculatePreviousTime(lookback: number): Date;
  marketDataProvider: IMarketDataProvider;
}
