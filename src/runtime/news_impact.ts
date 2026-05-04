import type { NewsItem } from "../extension/analysis-kit/data/interfaces.js";

export type NewsTheme =
  | "macro_geopolitical"
  | "regulation_compliance"
  | "security_incident"
  | "institutional_flow"
  | "onchain_flow"
  | "project_updates"
  | "exchange_operations"
  | "sentiment_commentary"
  | "other";

export interface NewsThemeCount {
  theme: NewsTheme;
  count: number;
}

export interface NewsFlag {
  time: string;
  title: string;
  reason: string;
}

export type NewsRiskRegime = "normal" | "elevated" | "severe";

export type NewsPreferenceAsset = "BTC" | "ETH";

export interface NewsAssetPreferenceTilt {
  favoredAsset: NewsPreferenceAsset | null;
  /**
   * Signed BTC-vs-ETH tilt in [-0.15, 0.15].
   * Positive values mildly favor BTC exposure, negative values mildly favor ETH.
   */
  btcVsEthTilt: number;
  reasons: string[];
}

export interface NewsOverlaySummary {
  riskRegime: NewsRiskRegime;
  hardVeto: boolean;
  /**
   * Exposure scaler in [0, 1]. Severe news drives this to 0, elevated risk scales down
   * but does not create or flip direction on its own.
   */
  exposureMultiplier: number;
  assetPreference: NewsAssetPreferenceTilt;
  reasons: string[];
}

export interface NewsImpactSummary {
  totalNews: number;
  positiveNews: number;
  negativeNews: number;
  neutralNews: number;
  highRiskNews: number;
  sentimentScore: number;
  riskScore: number;
  topThemes: NewsThemeCount[];
  flags: NewsFlag[];
  overlay?: NewsOverlaySummary;
}

export interface AnalyzeNewsImpactOptions {
  now?: Date;
  maxFlags?: number;
  sourceWeights?: Record<string, number>;
}

const DEFAULT_SOURCE_WEIGHTS: Record<string, number> = {
  Reuters: 1.2,
  Bloomberg: 1.2,
  CoinDesk: 1.1,
  TheBlock: 1.1,
  TechFlow: 1.0,
  unknown: 0.9,
};

const POSITIVE_PATTERNS = [
  /\binflow(s)?\b/i,
  /\bapproval\b/i,
  /\bupgrade(s|d)?\b/i,
  /\bpartnership\b/i,
  /\bbuyback\b/i,
  /\bstrategic reserve\b/i,
  /\btokenized\b/i,
  /\bon-?chain bond\b/i,
  /\brebound\b/i,
  /\baccumulat(e|ing|ion)\b/i,
];

const NEGATIVE_PATTERNS = [
  /\bhack(ed|er|ing)?\b/i,
  /\bexploit(ed)?\b/i,
  /\bbreach\b/i,
  /\bfraud\b/i,
  /\blaunder(ing|ed)?\b/i,
  /\bliquidat(ed|ion|ing)\b/i,
  /\bdump(s|ed|ing)?\b/i,
  /\bsell(-| )?off\b/i,
  /\btariff(s)?\b/i,
  /\bsanction(s|ed)?\b/i,
  /\bloss(es)?\b/i,
  /\battack(ed|s)?\b/i,
];

const RISK_PATTERNS = [
  /\bhack(ed|er|ing)?\b/i,
  /\bexploit(ed)?\b/i,
  /\bbreach\b/i,
  /\bfraud\b/i,
  /\blaunder(ing|ed)?\b/i,
  /\bsanction(s|ed)?\b/i,
  /\bwar\b/i,
  /\bconflict\b/i,
  /\btariff(s)?\b/i,
  /\bvolatility\b/i,
  /\bsuspend(ed|ing)?\b/i,
  /\bliquidat(ed|ion|ing)\b/i,
];

const SEVERE_RISK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bhack(ed|er|ing)?\b/i, reason: "security_incident" },
  { pattern: /\bexploit(ed)?\b/i, reason: "security_incident" },
  { pattern: /\bbreach\b/i, reason: "security_incident" },
  { pattern: /\bfraud\b/i, reason: "fraud_or_enforcement" },
  { pattern: /\blaunder(ing|ed)?\b/i, reason: "fraud_or_enforcement" },
  { pattern: /\bsanction(s|ed)?\b/i, reason: "sanctions_risk" },
  { pattern: /\bwar\b/i, reason: "geopolitical_risk" },
  { pattern: /\bconflict\b/i, reason: "geopolitical_risk" },
];

const THEME_PATTERNS: Array<{ theme: NewsTheme; patterns: RegExp[] }> = [
  {
    theme: "macro_geopolitical",
    patterns: [/\btariff(s)?\b/i, /\bfed\b/i, /\btreasury\b/i, /\biran\b/i, /\bgeopolitical\b/i],
  },
  {
    theme: "regulation_compliance",
    patterns: [
      /\bregulat(ion|ory)\b/i,
      /\bcompliance\b/i,
      /\bcourt\b/i,
      /\bguilty\b/i,
      /\blicense\b/i,
      /\bsec\b/i,
      /\bsfc\b/i,
    ],
  },
  {
    theme: "security_incident",
    patterns: [/\bhack(ed|er|ing)?\b/i, /\bexploit(ed)?\b/i, /\bbreach\b/i, /\bprivate key\b/i],
  },
  {
    theme: "institutional_flow",
    patterns: [/\betf\b/i, /\btokeniz(ed|ation)\b/i, /\bmoney market\b/i, /\basset management\b/i],
  },
  {
    theme: "onchain_flow",
    patterns: [/\bwhale\b/i, /\bdeposit(ed|ing)?\b/i, /\bwithdraw(n)?\b/i, /\bonchain\b/i, /\bwallet\b/i],
  },
  {
    theme: "project_updates",
    patterns: [/\broadmap\b/i, /\bupgrade\b/i, /\bproposal\b/i, /\blaunch(es|ed)?\b/i, /\bprotocol\b/i],
  },
  {
    theme: "exchange_operations",
    patterns: [/\bbinance\b/i, /\bokx\b/i, /\bbybit\b/i, /\bbitget\b/i, /\bpre-market\b/i],
  },
  {
    theme: "sentiment_commentary",
    patterns: [/\beconomist\b/i, /\bresearch\b/i, /\boutlook\b/i, /\bprobability\b/i, /\btarget\b/i],
  },
];

const BTC_PATTERNS = [
  /\bbitcoin\b/i,
  /\bbtc\b/i,
  /\bspot etf\b/i,
  /\bstrategic reserve\b/i,
  /\btreasury\b/i,
];

const ETH_PATTERNS = [
  /\bethereum\b/i,
  /\beth\b/i,
  /\bether\b/i,
  /\bstaking\b/i,
  /\blayer 2\b/i,
  /\brollup(s)?\b/i,
  /\bdeveloper\b/i,
];

const ELEVATED_RISK_SCORE = 0.35;
const MAX_BTC_ETH_TILT = 0.15;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function countMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      count += 1;
    }
  }
  return count;
}

function detectTheme(text: string): NewsTheme {
  let bestTheme: NewsTheme = "other";
  let bestHits = 0;
  for (const candidate of THEME_PATTERNS) {
    const hits = countMatches(text, candidate.patterns);
    if (hits > bestHits) {
      bestHits = hits;
      bestTheme = candidate.theme;
    }
  }
  return bestTheme;
}

function resolveSourceWeight(
  item: NewsItem,
  sourceWeights: Record<string, number> | undefined,
): number {
  const source = item.metadata?.source ?? "unknown";
  if (sourceWeights && typeof sourceWeights[source] === "number") {
    return sourceWeights[source];
  }
  if (typeof DEFAULT_SOURCE_WEIGHTS[source] === "number") {
    return DEFAULT_SOURCE_WEIGHTS[source];
  }
  return DEFAULT_SOURCE_WEIGHTS.unknown;
}

function resolveFlagReason(text: string): string | null {
  for (const item of SEVERE_RISK_PATTERNS) {
    if (item.pattern.test(text)) {
      return item.reason;
    }
  }
  return null;
}

function resolveOverlay(
  riskScore: number,
  severeFlags: number,
  highRiskNews: number,
  btcBias: number,
  ethBias: number,
): NewsOverlaySummary {
  const reasons: string[] = [];

  let riskRegime: NewsRiskRegime = "normal";
  let hardVeto = false;
  let exposureMultiplier = 1;

  if (severeFlags > 0) {
    riskRegime = "severe";
    hardVeto = true;
    exposureMultiplier = 0;
    reasons.push("severe_risk_flag");
  } else if (riskScore >= ELEVATED_RISK_SCORE || highRiskNews > 0) {
    riskRegime = "elevated";
    exposureMultiplier = Number(clamp(1 - riskScore * 0.8, 0.35, 0.85).toFixed(4));
    reasons.push("elevated_risk_scaler");
  }

  const assetReasons: string[] = [];
  const assetBiasDenominator = Math.max(1, Math.abs(btcBias) + Math.abs(ethBias));
  const assetTiltRaw = clamp((btcBias - ethBias) / assetBiasDenominator, -1, 1);
  const btcVsEthTilt = Number((assetTiltRaw * MAX_BTC_ETH_TILT).toFixed(4));

  let favoredAsset: NewsPreferenceAsset | null = null;
  if (btcVsEthTilt >= 0.03) {
    favoredAsset = "BTC";
    assetReasons.push("btc_relative_news_tailwind");
  } else if (btcVsEthTilt <= -0.03) {
    favoredAsset = "ETH";
    assetReasons.push("eth_relative_news_tailwind");
  }

  if (favoredAsset) {
    reasons.push(`asset_preference:${favoredAsset}`);
  }

  return {
    riskRegime,
    hardVeto,
    exposureMultiplier,
    assetPreference: {
      favoredAsset,
      btcVsEthTilt,
      reasons: assetReasons,
    },
    reasons,
  };
}

export function analyzeNewsImpact(
  news: NewsItem[],
  options?: AnalyzeNewsImpactOptions,
): NewsImpactSummary {
  if (news.length === 0) {
    return {
      totalNews: 0,
      positiveNews: 0,
      negativeNews: 0,
      neutralNews: 0,
      highRiskNews: 0,
      sentimentScore: 0,
      riskScore: 0,
      topThemes: [],
      flags: [],
      overlay: {
        riskRegime: "normal",
        hardVeto: false,
        exposureMultiplier: 1,
        assetPreference: {
          favoredAsset: null,
          btcVsEthTilt: 0,
          reasons: [],
        },
        reasons: [],
      },
    };
  }

  const nowMs = (options?.now ?? new Date()).getTime();
  const maxFlags = options?.maxFlags ?? 8;

  let positiveNews = 0;
  let negativeNews = 0;
  let neutralNews = 0;
  let highRiskNews = 0;

  let weightedSentiment = 0;
  let weightedSentimentDenominator = 0;
  let weightedRisk = 0;
  let severeFlags = 0;
  let btcBias = 0;
  let ethBias = 0;

  const themeCounts = new Map<NewsTheme, number>();
  const flags: NewsFlag[] = [];

  for (const item of news) {
    const text = `${item.title} ${item.content}`.toLowerCase();
    const pos = countMatches(text, POSITIVE_PATTERNS);
    const neg = countMatches(text, NEGATIVE_PATTERNS);
    const signed = pos - neg;

    if (signed > 0) {
      positiveNews += 1;
    } else if (signed < 0) {
      negativeNews += 1;
    } else {
      neutralNews += 1;
    }

    const hoursAgo = Math.max(0, (nowMs - item.time.getTime()) / 3_600_000);
    const recencyWeight = clamp(Math.exp(-hoursAgo / 48), 0.35, 1);
    const sourceWeight = resolveSourceWeight(item, options?.sourceWeights);
    const itemWeight = recencyWeight * sourceWeight;

    if (signed !== 0) {
      weightedSentiment += signed * itemWeight;
      weightedSentimentDenominator += Math.max(1, Math.abs(signed)) * itemWeight;
    }

    const riskHits = countMatches(text, RISK_PATTERNS);
    const severeReason = resolveFlagReason(text);
    if (riskHits >= 2 || severeReason) {
      highRiskNews += 1;
      if (flags.length < maxFlags) {
        flags.push({
          time: item.time.toISOString(),
          title: item.title,
          reason: severeReason ?? "multi_risk_keywords",
        });
      }
    }
    if (severeReason) {
      severeFlags += 1;
    }

    const riskStrength = riskHits * 0.5 + (severeReason ? 1.0 : 0);
    weightedRisk += riskStrength * itemWeight;

    const theme = detectTheme(text);
    themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);

    const btcHits = countMatches(text, BTC_PATTERNS);
    const ethHits = countMatches(text, ETH_PATTERNS);
    if (btcHits > 0) {
      btcBias += signed * itemWeight;
      if (theme === "institutional_flow") {
        btcBias += 0.35 * itemWeight;
      }
    }
    if (ethHits > 0) {
      ethBias += signed * itemWeight;
      if (theme === "project_updates") {
        ethBias += 0.35 * itemWeight;
      }
    }
  }

  const sentimentScore =
    weightedSentimentDenominator > 0
      ? clamp(weightedSentiment / weightedSentimentDenominator, -1, 1)
      : 0;

  const riskScore = clamp(weightedRisk / (news.length * 1.6), 0, 1);

  const topThemes = [...themeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([theme, count]) => ({ theme, count }));

  const overlay = resolveOverlay(riskScore, severeFlags, highRiskNews, btcBias, ethBias);

  return {
    totalNews: news.length,
    positiveNews,
    negativeNews,
    neutralNews,
    highRiskNews,
    sentimentScore: Number(sentimentScore.toFixed(4)),
    riskScore: Number(riskScore.toFixed(4)),
    topThemes,
    flags,
    overlay,
  };
}
