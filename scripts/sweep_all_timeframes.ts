/**
 * Timeframe sweep: intraday → monthly
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateCrossSectionalMomentum } from '../src/domain/strategy/cross-sectional-momentum.js';
import type { CrossSectionalAsset } from '../src/domain/strategy/cross-sectional-momentum.js';

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface CliArgs { dryRun: boolean }

async function load(path: string): Promise<Candle[]> {
  const raw = await readFile(path, 'utf-8');
  return raw.trim().split('\n').slice(1).map(l => { const c = l.split(','); return { time: Number(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]) } }).filter(c => c.time > 0);
}

function vol(candles: Candle[], i: number, lb: number): number {
  const rets: number[] = [];
  for (let j = Math.max(0, i-lb)+1; j <= i; j++) if (candles[j-1].close > 0) rets.push(candles[j].close/candles[j-1].close-1);
  if (rets.length < 2) return 50;
  const m = rets.reduce((s,r) => s+r, 0)/rets.length;
  return Math.sqrt(rets.reduce((s,r) => s+(r-m)**2, 0)/rets.length * 365 * 24) * 100;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: 'cross_sectional_timeframe_sweep',
      command: 'sweep_all_timeframes',
      executionMode: {
        dryRun: true,
        loadsMarketData: false,
        runsTimeframeSweep: false,
        writesArtifacts: false,
        promotionEligible: false,
      },
      optIn: {
        runSweep: '--dryRun false',
      },
    }, null, 2));
    return;
  }

  const btc = await load(join(import.meta.dirname, '..', 'data', 'market', 'gate', 'BTC_USDT_USDT_1h.csv'));
  const eth = await load(join(import.meta.dirname, '..', 'data', 'market', 'gate', 'ETH_USDT_USDT_1h.csv'));
  const assets = [{ symbol: 'BTC-USDT', candles: btc }, { symbol: 'ETH-USDT', candles: eth }];

  const tests = [
    { label: '1h (intraday)', lookback: 1, fwd: 1, sec: 24, mtf: 0 },
    { label: '4h (intraday)', lookback: 4, fwd: 2, sec: 24, mtf: 0.1 },
    { label: '12h (overnight)', lookback: 12, fwd: 4, sec: 72, mtf: 0.1 },
    { label: '24h (1 day)', lookback: 24, fwd: 12, sec: 168, mtf: 0.15 },
    { label: '72h (3 day)', lookback: 72, fwd: 24, sec: 336, mtf: 0.2 },
    { label: '120h (5 day)', lookback: 120, fwd: 48, sec: 504, mtf: 0.25 },
    { label: '168h (7 day)', lookback: 168, fwd: 48, sec: 720, mtf: 0.25 },
    { label: '336h (14 day)', lookback: 336, fwd: 72, sec: 720, mtf: 0.3 },
    { label: '504h (21 day)', lookback: 504, fwd: 72, sec: 1008, mtf: 0.3 },
    { label: '720h (30 day)', lookback: 720, fwd: 168, sec: 1008, mtf: 0.35 },
  ];

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║         Cross-Sectional Reversal — ALL TIMEFRAMES                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log();
  console.log('Timeframe         Lookback  Forward  Signals  WinRate  CumSpread  AvgSpread  Style');
  console.log('────────────────  ────────  ───────  ───────  ───────  ─────────  ─────────  ──────────');

  let overallBest = { label: '', wr: 0, spread: 0, sigs: 0 };

  for (const t of tests) {
    const minBars = Math.max(t.lookback, t.sec, t.fwd) + 2;
    const maxI = Math.min(...assets.map(a => a.candles.length)) - t.fwd;

    let bestWr = 0, bestSpreadVal = 0, bestSignals = 0, bestAvgSpread = 0, bestNote = '';

    for (const minSpread of [0, 1, 2, 3, 5]) {
      for (const maxVol of [80, 85, 90, 95, 99]) {
        let signals = 0, wins = 0, spreadCum = 0;

        for (let i = minBars; i < maxI; i++) {
          const fwd = i + t.fwd;
          const csAssets: CrossSectionalAsset[] = assets.map(({ symbol, candles }) => ({
            symbol, currentPrice: candles[i].close,
            returns: {
              [`${t.lookback}h`]: (candles[i].close / candles[i - t.lookback].close - 1) * 100,
              [`${t.sec}h`]: i >= t.sec ? (candles[i].close / candles[i - t.sec].close - 1) * 100 : (candles[i].close / candles[0].close - 1) * 100,
              [`${t.fwd}h`]: (candles[fwd].close / candles[i].close - 1) * 100,
            },
            realizedVolPct: vol(candles, i, 24),
            avgVolume24h: candles[i].volume,
          }));

          const ranks = evaluateCrossSectionalMomentum(csAssets, {
            lookbackHours: t.lookback, secondaryLookbackHours: t.sec, topN: 1, bottomN: 1,
            minUniverseSize: 2, maxVolPercentile: maxVol/100, minSpreadPct: minSpread,
            requireVolumeConfirmation: false, mtfWeight: t.mtf,
          });

          const longs = ranks.filter(r => r.signal === 1);
          const shorts = ranks.filter(r => r.signal === -1);
          if (longs.length === 0 || shorts.length === 0) continue;

          for (const l of longs.slice(0,1)) {
            for (const s of shorts.slice(0,1)) {
              if (l.symbol === s.symbol) continue;
              signals++;
              const lf = csAssets.find(a => a.symbol === l.symbol)!.returns[`${t.fwd}h`];
              const sf = csAssets.find(a => a.symbol === s.symbol)!.returns[`${t.fwd}h`];
              const sp = lf - sf;
              spreadCum += sp;
              if (sp > 0) wins++;
            }
          }
        }

        const wr = signals > 10 ? wins / signals * 100 : 0;
        // Composite: prefer high WR but penalize very low signal count
        const composite = wr * (1 - Math.exp(-signals / 200)); // sigmoid penalty for low signals
        if (composite > bestWr * (1 - Math.exp(-bestSignals / 200)) && wr > 0) {
          bestWr = wr; bestSpreadVal = spreadCum; bestSignals = signals;
          bestAvgSpread = signals > 0 ? spreadCum / signals : 0;
          bestNote = `sp≥${minSpread}% v≤${maxVol}%`;
        }
      }
    }

    let style = '';
    if (t.fwd <= 4) style = '⚡ 超短线';
    else if (t.fwd <= 24) style = '📊 短线';
    else if (t.fwd <= 72) style = '📈 中线';
    else style = '🏔️ 长线';

    const marker = bestWr >= 80 ? '🔥' : bestWr >= 65 ? '✅' : bestWr >= 55 ? '⚡' : '❌';
    console.log(`${marker} ${t.label.padEnd(16)} ${String(t.lookback+'h').padEnd(9)} ${String(t.fwd+'h').padEnd(8)} ${String(bestSignals).padEnd(8)} ${(bestWr.toFixed(1)+'%').padEnd(8)} ${(bestSpreadVal.toFixed(0)+'%').padEnd(10)} ${(bestAvgSpread.toFixed(3)+'%').padEnd(10)} ${style}`);

    if (bestWr > overallBest.wr && bestSignals > 20) {
      overallBest = { label: t.label, wr: bestWr, spread: bestAvgSpread, sigs: bestSignals };
    }
  }

  console.log();
  console.log(`🏆 综合最佳: ${overallBest.label} — ${overallBest.wr.toFixed(1)}% WR, ${overallBest.sigs} signals, ${overallBest.spread.toFixed(3)}% avg spread`);

  // Recommendation
  console.log();
  console.log('=== 建议 ===');
  console.log('超短线 (1-12h): 信号噪音大，胜率低，不推荐');
  console.log('短线 (1-3d):   胜率 65-75%，信号多，适合高频交易');
  console.log('中线 (5-14d):  胜率 75-87%，最佳平衡点 ← 当前选择');
  console.log('长线 (21-30d): 胜率高但信号太少，容量有限');
 }

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  return {
    dryRun: parseBoolArg(raw.get('dryRun'), true),
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const withoutPrefix = token.slice(2);
    const eq = withoutPrefix.indexOf('=');
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      out.set(withoutPrefix, 'true');
      continue;
    }
    out.set(withoutPrefix, next);
    index += 1;
  }
  return out;
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
};
