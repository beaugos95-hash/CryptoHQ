import "dotenv/config";

/** Returns the first non-empty value among several env var names (aliases). */
function raw(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function num(name: string, fallback: number): number {
  const value = raw(name);
  if (value === undefined) return fallback;
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error(`Invalid numeric value for ${name}: "${value}"`);
  return v;
}

function bool(fallback: boolean, ...names: string[]): boolean {
  const value = raw(...names);
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function str(fallback: string, ...names: string[]): string {
  return raw(...names) ?? fallback;
}

/**
 * Configuration. Fields are mutable on purpose: the Telegram /set command
 * adjusts trading parameters at runtime without a restart.
 * Env var aliases (PAPER_TRADING, SOLANA_PRIVATE_KEY…) are accepted for
 * compatibility with common .env layouts.
 */
export const config = {
  /** Paper-trading mode: no real transaction is ever sent when true. DEFAULT: true. */
  dryRun: bool(true, "DRY_RUN", "PAPER_TRADING"),
  /** Start with trading enabled; when false, wait for /startbot on Telegram. */
  autostart: bool(true, "AUTOSTART", "THEBOT_AUTOSTART"),

  rpcUrl: str("https://api.mainnet-beta.solana.com", "RPC_URL", "SOLANA_RPC_URL"),
  /** Base58-encoded private key. Only required when DRY_RUN=false. */
  privateKey: raw("PRIVATE_KEY", "SOLANA_PRIVATE_KEY") ?? "",

  jupiterBaseUrl: str("https://lite-api.jup.ag", "JUPITER_BASE_URL", "JUPITER_API_URL"),

  /** Virtual wallet size for paper trading, in EUR. */
  paperBalanceEur: num("PAPER_BALANCE_EUR", 500),

  // ---- Trade sizing & risk ----
  /** Stake for the MOST volatile tokens, in EUR (converted to SOL at buy time). */
  minStakeEur: num("MIN_STAKE_EUR", 10),
  /** Stake for the LEAST volatile tokens, in EUR. */
  maxStakeEur: num("MAX_STAKE_EUR", 50),
  /** Max number of simultaneously open positions. */
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 3),
  /** Max slippage tolerated on swaps, in basis points (300 = 3%). */
  slippageBps: num("SLIPPAGE_BPS", 300),

  // ---- Take-profit ladder ----
  /** Base hard stop-loss in percent, active until TP1 (e.g. 12 = -12%). */
  stopLossPct: num("STOP_LOSS_PCT", 12),
  /** TP1 trigger in percent: sell half the position, lock the stop at TP1_FLOOR_PCT. */
  tp1Pct: num("TP1_PCT", 15),
  /** After TP1, exit everything if PnL falls back to this floor (in percent). */
  tp1FloorPct: num("TP1_FLOOR_PCT", 10),
  /** TP2 trigger in percent: sell half of what remains, lock the stop at TP2_FLOOR_PCT. */
  tp2Pct: num("TP2_PCT", 35),
  /** After TP2, exit everything if PnL falls back to this floor (in percent). */
  tp2FloorPct: num("TP2_FLOOR_PCT", 30),
  /** TP3 trigger in percent: sell the rest except RUNNER_KEEP_FRACTION left running. */
  tp3Pct: num("TP3_PCT", 75),
  /** Fraction of the remaining bag kept as a "runner" at TP3 (0.1 = 10%). */
  runnerKeepFraction: num("RUNNER_KEEP_FRACTION", 0.1),
  /** Runner trailing stop distance in PnL points below the peak (ratchets up only).
   *  Example: peak +135% with 20 -> stop at +115%. */
  runnerTrailPct: num("RUNNER_TRAIL_PCT", 20),

  // ---- Daily circuit breakers ----
  /** Stop opening positions for the UTC day once the day's realized loss
   *  reaches this share of the day-start balance, in percent (0 disables). */
  maxDailyLossPct: num("MAX_DAILY_LOSS_PCT", 25),
  /** Daily profit lock: once the day's profit reaches this percent of the
   *  day-start balance, protect it by tiers (0 disables). */
  dailyProfitLockPct: num("DAILY_PROFIT_LOCK_PCT", 25),
  /** Tier size for the daily profit lock, in percent points. Example: peak
   *  +45% with tier 5 -> stop trading for the day if profit drops below +40%. */
  dailyProfitTierPct: num("DAILY_PROFIT_TIER_PCT", 5),

  /** Force-exit a position after this many minutes if no TP was hit (0 disables). */
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
  requirePositiveMomentum: bool(true, "REQUIRE_POSITIVE_MOMENTUM"),
  /** Max share of supply held by the single largest non-pool holder, in percent. */
  maxTopHolderPct: num("MAX_TOP_HOLDER_PCT", 15),
  /** Honeypot guard: simulate a sell route before buying and reject the token
   *  if selling is impossible or the round trip loses too much. */
  honeypotCheck: bool(true, "HONEYPOT_CHECK"),
  /** Max acceptable buy+sell round-trip loss in percent for the honeypot guard. */
  maxRoundTripLossPct: num("MAX_ROUND_TRIP_LOSS_PCT", 10),

  // ---- Loop timing ----
  /** Delay between discovery scans, in seconds. */
  scanIntervalSec: num("SCAN_INTERVAL_SEC", 20),
  /** Delay between open-position price checks, in seconds. */
  monitorIntervalSec: num("MONITOR_INTERVAL_SEC", 5),
  /** Cooldown before re-buying a token we already traded, in minutes. */
  reentryCooldownMinutes: num("REENTRY_COOLDOWN_MINUTES", 120),

  /** File where the bot persists its state (positions, history) across restarts. */
  stateFile: str("state/bot-state.json", "STATE_FILE"),

  // ---- External data sources (optional) ----
  /** Birdeye API key: token overviews and social-link enrichment. */
  birdeyeApiKey: raw("BIRDEYE_API_KEY") ?? "",
  /** Twitter/X API v2 bearer token: social buzz scoring (paid API). */
  twitterBearerToken: raw("TWITTER_BEARER_TOKEN") ?? "",
  /** GMGN trending feed (best effort: gmgn.ai has no official public API). */
  gmgnEnabled: bool(true, "GMGN_ENABLED"),
  /** Extra score bonus applied to candidates with an active social presence. */
  socialScoreBonus: num("SOCIAL_SCORE_BONUS", 2),

  // ---- Telegram (notifications + full remote control) ----
  telegramBotToken: raw("TELEGRAM_BOT_TOKEN") ?? "",
  telegramChatId: raw("TELEGRAM_CHAT_ID") ?? "",
};

export type Config = typeof config;

/** Parameters adjustable at runtime via the Telegram /set command. */
export const TUNABLE_KEYS = [
  "minStakeEur",
  "maxStakeEur",
  "maxOpenPositions",
  "slippageBps",
  "stopLossPct",
  "tp1Pct",
  "tp1FloorPct",
  "tp2Pct",
  "tp2FloorPct",
  "tp3Pct",
  "runnerKeepFraction",
  "runnerTrailPct",
  "maxDailyLossPct",
  "dailyProfitLockPct",
  "dailyProfitTierPct",
  "maxHoldMinutes",
  "minLiquidityUsd",
  "maxFdvUsd",
  "minFdvUsd",
  "minVolume24hUsd",
  "minBuysLastHour",
  "maxTopHolderPct",
  "maxRoundTripLossPct",
  "scanIntervalSec",
  "monitorIntervalSec",
  "reentryCooldownMinutes",
  "socialScoreBonus",
] as const satisfies readonly (keyof Config)[];

export type TunableKey = (typeof TUNABLE_KEYS)[number];

export function validateConfig(): void {
  if (!config.dryRun && !config.privateKey) {
    throw new Error("DRY_RUN=false requires PRIVATE_KEY to be set");
  }
  if (config.minStakeEur <= 0) throw new Error("MIN_STAKE_EUR must be > 0");
  if (config.maxStakeEur < config.minStakeEur) {
    throw new Error("MAX_STAKE_EUR must be >= MIN_STAKE_EUR");
  }
  if (config.slippageBps <= 0 || config.slippageBps > 5_000) {
    throw new Error("SLIPPAGE_BPS must be between 1 and 5000");
  }
  if (config.stopLossPct <= 0 || config.stopLossPct >= 100) {
    throw new Error("STOP_LOSS_PCT must be between 1 and 99");
  }
  if (config.maxOpenPositions < 1) throw new Error("MAX_OPEN_POSITIONS must be >= 1");
  if (!(config.tp1Pct < config.tp2Pct && config.tp2Pct < config.tp3Pct)) {
    throw new Error("TP levels must be increasing: TP1_PCT < TP2_PCT < TP3_PCT");
  }
  if (config.tp1FloorPct >= config.tp1Pct) {
    throw new Error("TP1_FLOOR_PCT must be lower than TP1_PCT");
  }
  if (config.tp2FloorPct >= config.tp2Pct) {
    throw new Error("TP2_FLOOR_PCT must be lower than TP2_PCT");
  }
  if (config.runnerKeepFraction <= 0 || config.runnerKeepFraction >= 1) {
    throw new Error("RUNNER_KEEP_FRACTION must be strictly between 0 and 1");
  }
  if (config.runnerTrailPct <= 0) throw new Error("RUNNER_TRAIL_PCT must be > 0");
  if (config.telegramBotToken !== "" && config.telegramChatId === "") {
    throw new Error("TELEGRAM_CHAT_ID is required when TELEGRAM_BOT_TOKEN is set");
  }
}
