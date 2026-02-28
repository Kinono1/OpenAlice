export interface TradingRuntimeModeInput {
  sandbox: boolean;
  demoTrading?: boolean;
}

export interface TradingGuardEnv {
  TRADE_TOKEN?: string;
  AUTH_TOKEN?: string;
  DISABLE_TRADE_AUTH_TOKEN_ENFORCE?: string;
  ALLOW_LIVE_TRADING?: string;
}

export function parseBoolEnv(raw: string | undefined): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function assertTradingInterfaceAuthToken(env: TradingGuardEnv): void {
  const tradeToken = String(env.TRADE_TOKEN ?? "").trim();
  const authToken = String(env.AUTH_TOKEN ?? "").trim();
  const enforceToken = !parseBoolEnv(env.DISABLE_TRADE_AUTH_TOKEN_ENFORCE);
  if (!enforceToken) {
    return;
  }
  if (tradeToken || authToken) {
    return;
  }
  throw new Error(
    "Trading interface auth token missing: set TRADE_TOKEN or AUTH_TOKEN " +
      "(or explicitly disable via DISABLE_TRADE_AUTH_TOKEN_ENFORCE=true for isolated local debugging).",
  );
}

export function assertSafeTradingMode(
  input: TradingRuntimeModeInput,
  env: TradingGuardEnv,
): void {
  const sandbox = Boolean(input.sandbox);
  const demoTrading = Boolean(input.demoTrading);
  if (sandbox || demoTrading) {
    return;
  }
  if (parseBoolEnv(env.ALLOW_LIVE_TRADING)) {
    return;
  }
  throw new Error(
    "Live trading is blocked by default. Enable sandbox/demo first, or set " +
      "ALLOW_LIVE_TRADING=true for an explicit real-trading override.",
  );
}

