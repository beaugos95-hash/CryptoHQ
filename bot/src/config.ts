import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Invalid numeric value for ${name}: "${raw}"`);
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export const config = {
  /** Paper-trading mode: no real transaction is ever sent when true. DEFAULT: true. */
  dryRun: bool("DRY_RUN", true),

  rpcUrl: str("RPC_URL", "https://api.mainnet-beta.solana.com"),
  /** Base58-encoded private key. Only required when DRY_RUN=false. */
  privateKey: process.env.PRIVATE_KEY ?? "",

  jupiterBaseUrl: str("JUPITER_BASE_URL", "https://lite-api.jup.ag"),

  // ---- Trade sizing & risk ----
  /** Amount of SOL committed per position. */
  buyAmountSol: num("BUY_AMOUNT_SOL", 0.05),
  /** Max number of simultaneously open positions. */
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 3),
  /** Max slippage tolerated on swaps, in basis points (300 = 3%). */
  slippageBps: num("SLIPPAGE_BPS", 300),
  /** Take-profit threshold in percent (e.g. 60 = +60%). */
  takeProfitPct: num("TAKE_PROFIT_PCT", 60),
  /** Hard stop-loss threshold in percent (e.g. 25 = -25%). */
  stopLossPct: num("STOP_LOSS_PCT", 25),
  /** Trailing stop: exit if price falls this % below the peak reached (0 disables). */
  trailingStopPct: num("TRAILING_STOP_PCT", 20),
  /** Force-exit a position after this many minutes regardless of PnL (0 disables). */
  maxHoldMinutes: num("MAX_HOLD_MINUTES", 60),
  /** Priority fee in micro-lamports per compute unit for fast inclusion. */
  priorityFeeMicroLamports: num("PRIORITY_FEE_MICRO_LAMPORTS", 250_000),

  // ---- Token discovery filters ----
  /** Minimum pool liquidity in USD to consider a token. */
  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 20_000),
  /** Maximum market cap / FDV in USD (we want early meme coins, not majors). */
  maxFdvUsd: num("MAX_FDV_USD", 5_000_000),
  /** Minimum FDV to skip dust tokens. */
  minFdvUsd: num("MIN_FDV_USD", 100_000),
  /** Minimum 24h volume in USD. */
  minVolume24hUsd: num("MIN_VOLUME_24H_USD", 50_000),
  /** Minimum pair age in minutes (avoid the first minutes where rugs are most common). */
  minPairAgeMinutes: num("MIN_PAIR_AGE_MINUTES", 30),
  /** Maximum pair age in hours (we only want fresh momentum). */
  maxPairAgeHours: num("MAX_PAIR_AGE_HOURS", 48),
  /** Minimum number of buy transactions in the last hour. */
  minBuysLastHour: num("MIN_BUYS_LAST_HOUR", 50),
  /** Require m5 price change to be positive (momentum entry). */
  requirePositiveMomentum: bool("REQUIRE_POSITIVE_MOMENTUM", true),
  /** Max share of supply held by the single largest non-pool holder, in percent. */
  maxTopHolderPct: num("MAX_TOP_HOLDER_PCT", 15),

  // ---- Loop timing ----
  /** Delay between discovery scans, in seconds. */
  scanIntervalSec: num("SCAN_INTERVAL_SEC", 20),
  /** Delay between open-position price checks, in seconds. */
  monitorIntervalSec: num("MONITOR_INTERVAL_SEC", 5),
  /** Cooldown before re-buying a token we already traded, in minutes. */
  reentryCooldownMinutes: num("REENTRY_COOLDOWN_MINUTES", 120),

  /** File where the bot persists its state (positions, history) across restarts. */
  stateFile: str("STATE_FILE", "state/bot-state.json"),
} as const;

export type Config = typeof config;

export function validateConfig(): void {
  if (!config.dryRun && !config.privateKey) {
    throw new Error("DRY_RUN=false requires PRIVATE_KEY to be set");
  }
  if (config.buyAmountSol <= 0) throw new Error("BUY_AMOUNT_SOL must be > 0");
  if (config.slippageBps <= 0 || config.slippageBps > 5_000) {
    throw new Error("SLIPPAGE_BPS must be between 1 and 5000");
  }
  if (config.stopLossPct <= 0 || config.stopLossPct >= 100) {
    throw new Error("STOP_LOSS_PCT must be between 1 and 99");
  }
  if (config.maxOpenPositions < 1) throw new Error("MAX_OPEN_POSITIONS must be >= 1");
}
