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
  /** Amount of SOL committed per position. */
  buyAmountSol: num("BUY_AMOUNT_SOL", 0.05),
  /** Max number of simultaneously open positions. */
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 3),
  /** Max slippage tolerated on swaps, in basis points (300 = 3%). */
  slippageBps: num("SLIPPAGE_BPS", 300),
  /** First take-profit level in percent: sell TP1_SELL_FRACTION of the bag (0 disables). */
  tp1Pct: num("TP1_PCT", 40),
  /** Fraction of the position sold at TP1 (0.5 = half). */
  tp1SellFraction: num("TP1_SELL_FRACTION", 0.5),
  /** Final take-profit threshold in percent: closes the whole position. */
  takeProfitPct: num("TAKE_PROFIT_PCT", 100),
  /** Hard stop-loss threshold in percent (e.g. 25 = -25%). */
  stopLossPct: num("STOP_LOSS_PCT", 25),
  /** Pause new buys for the rest of the UTC day once realized losses reach this (0 disables). */
  maxDailyLossSol: num("MAX_DAILY_LOSS_SOL", 0.25),
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
  "buyAmountSol",
  "maxOpenPositions",
  "slippageBps",
  "tp1Pct",
  "tp1SellFraction",
  "takeProfitPct",
  "stopLossPct",
  "trailingStopPct",
  "maxHoldMinutes",
  "maxDailyLossSol",
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
  if (config.buyAmountSol <= 0) throw new Error("BUY_AMOUNT_SOL must be > 0");
  if (config.slippageBps <= 0 || config.slippageBps > 5_000) {
    throw new Error("SLIPPAGE_BPS must be between 1 and 5000");
  }
  if (config.stopLossPct <= 0 || config.stopLossPct >= 100) {
    throw new Error("STOP_LOSS_PCT must be between 1 and 99");
  }
  if (config.maxOpenPositions < 1) throw new Error("MAX_OPEN_POSITIONS must be >= 1");
  if (config.tp1SellFraction <= 0 || config.tp1SellFraction >= 1) {
    throw new Error("TP1_SELL_FRACTION must be strictly between 0 and 1");
  }
  if (config.tp1Pct > 0 && config.tp1Pct >= config.takeProfitPct) {
    throw new Error("TP1_PCT must be lower than TAKE_PROFIT_PCT");
  }
  if (config.telegramBotToken !== "" && config.telegramChatId === "") {
    throw new Error("TELEGRAM_CHAT_ID is required when TELEGRAM_BOT_TOKEN is set");
  }
}
