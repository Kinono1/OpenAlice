export interface MarketData {
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NewsItemMetadata {
  source?: string;
  sourceUrl?: string;
  category?: string;
  sourceId?: string;
  sourceType?: string;
  sourcePriority?: string;
  [key: string]: unknown;
}

export interface NewsItem {
  time: Date;
  title: string;
  content: string;
  metadata: NewsItemMetadata;
}

export interface IMarketDataProvider {
  getMarketData(time: Date, symbol: string): Promise<MarketData>;
  getMarketDataRange(
    startTime: Date,
    endTime: Date,
    symbol: string
  ): Promise<MarketData[]>;
  getAvailableSymbols(): string[];
}
