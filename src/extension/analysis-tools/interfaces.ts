import type {
  IMarketDataProvider,
  NewsItem,
} from "../analysis-kit/data/interfaces.js";

export interface AnalysisNewsQuery {
  endTime?: Date;
  startTime?: Date;
  lookback?: string;
  limit?: number;
}

export interface IAnalysisContext {
  marketDataProvider: IMarketDataProvider;
  getPlayheadTime(): Date;
  calculatePreviousTime(lookbackBars: number): Date;
  getNewsV2(options: AnalysisNewsQuery): Promise<NewsItem[]>;
}
