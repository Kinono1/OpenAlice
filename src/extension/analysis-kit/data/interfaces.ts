export interface MarketData {
  symbol?: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IMarketDataProvider {
  getMarketData(time: Date, symbol: string): Promise<MarketData>;
  getMarketDataRange(
    startTime: Date,
    endTime: Date,
    symbol: string,
  ): Promise<MarketData[]>;
}

export interface NewsItem {
  time: Date;
  title: string;
  content: string;
  metadata?: Record<string, string | null | undefined>;
}
