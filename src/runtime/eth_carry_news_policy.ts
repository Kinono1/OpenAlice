import type { NewsItem } from "../extension/analysis-kit/data/interfaces.js";
import type { NewsFlag, NewsImpactSummary, NewsTheme } from "./news_impact.js";

export interface EthCarryNewsPolicyOptions {
  now?: Date;
  venues?: readonly ("binance" | "okx")[];
}

interface VenueIncidentEvidence {
  venue: "binance" | "okx";
  timeMs: number;
  title: string;
  tokens: Set<string>;
}

const DEFAULT_VENUES: readonly ("binance" | "okx")[] = ["binance", "okx"];
const INCIDENT_DETECTION_PATTERNS = [
  /\bhack(ed|er|ing)?\b/i,
  /\bexploit(ed)?\b/i,
  /\bbreach\b/i,
  /\boutage\b/i,
  /\bsuspend(ed|ing)?\b/i,
  /\bhalt(ed|ing)?\b/i,
  /\bfreeze(d)?\b/i,
  /\bwithdraw(al|als)?\s+halt\b/i,
  /\bincident\b/i,
  /\bservice disruption\b/i,
  /\bsecurity incident\b/i,
  /\bmaintenance issue\b/i,
  /\bwallet issue\b/i,
  /\basset loss\b/i,
];

const INCIDENT_DEDUP_WINDOW_HOURS = 6;

function normalizeTitleTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => token.length > 2);

  return new Set(tokens);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function detectVenue(
  text: string,
  venues: readonly ("binance" | "okx")[],
): "binance" | "okx" | null {
  for (const venue of venues) {
    const pattern = venue === "binance" ? /\bbinance\b/i : /\bokx\b/i;
    if (pattern.test(text)) {
      return venue;
    }
  }
  return null;
}

function isIncidentHeadline(text: string): boolean {
  return INCIDENT_DETECTION_PATTERNS.some(pattern => pattern.test(text));
}

function detectVenueIncidents(
  news: NewsItem[],
  venues: readonly ("binance" | "okx")[],
): VenueIncidentEvidence[] {
  const accepted: VenueIncidentEvidence[] = [];
  for (const item of news) {
    const text = `${item.title} ${item.content}`.toLowerCase();
    const venue = detectVenue(text, venues);
    if (!venue || !isIncidentHeadline(text)) {
      continue;
    }

    const candidate: VenueIncidentEvidence = {
      venue,
      timeMs: item.time.getTime(),
      title: item.title,
      tokens: normalizeTitleTokens(item.title),
    };

    const isDuplicate = accepted.some(existing => {
      if (existing.venue !== candidate.venue) {
        return false;
      }
      if (
        Math.abs(existing.timeMs - candidate.timeMs) >
        INCIDENT_DEDUP_WINDOW_HOURS * 3_600_000
      ) {
        return false;
      }
      return jaccardSimilarity(existing.tokens, candidate.tokens) >= 0.8;
    });

    if (!isDuplicate) {
      accepted.push(candidate);
    }
  }

  return accepted;
}

export function applyEthCarryNewsPolicy(
  summary: NewsImpactSummary,
  news: NewsItem[],
  options?: EthCarryNewsPolicyOptions,
): NewsImpactSummary {
  const venues = options?.venues ?? DEFAULT_VENUES;
  const incidents = detectVenueIncidents(news, venues);
  if (incidents.length === 0) {
    return summary;
  }

  const overlay = summary.overlay
    ? {
        ...summary.overlay,
        assetPreference: {
          ...summary.overlay.assetPreference,
          reasons: [...summary.overlay.assetPreference.reasons],
        },
        reasons: [...summary.overlay.reasons],
      }
    : undefined;

  const reasons = new Set(overlay?.reasons ?? []);
  const flags: NewsFlag[] = [...summary.flags];

  for (const incident of incidents) {
    const reason = `eth_carry_exchange_incident:${incident.venue}`;
    reasons.add(reason);
    if (!flags.some(flag => flag.reason === reason && flag.title === incident.title)) {
      flags.push({
        time: new Date(incident.timeMs).toISOString(),
        title: incident.title,
        reason,
        theme: "exchange_operations" satisfies NewsTheme,
        severity: "severe",
      });
    }
  }

  return {
    ...summary,
    flags,
    overlay: overlay
      ? {
          ...overlay,
          riskRegime: "severe",
          hardVeto: true,
          exposureMultiplier: 0,
          reasons: [...reasons, "eth_carry_venue_incident"],
        }
      : {
          riskRegime: "severe",
          hardVeto: true,
          exposureMultiplier: 0,
          assetPreference: {
            favoredAsset: null,
            btcVsEthTilt: 0,
            reasons: [],
          },
          reasons: [...reasons, "eth_carry_venue_incident"],
        },
  };
}
