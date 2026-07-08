// ---- DexScreener API ----

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd?: string;
  txns?: Partial<Record<"m5" | "h1" | "h6" | "h24", { buys: number; sells: number }>>;
  volume?: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  priceChange?: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

export interface TokenProfile {
  chainId: string;
  tokenAddress: string;
  description?: string;
  links?: { type?: string; label?: string; url: string }[];
}

// ---- Candidate produced by discovery ----

export interface TokenCandidate {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  priceUsd: number;
  liquidityUsd: number;
  fdvUsd: number;
  volume24hUsd: number;
  buysLastHour: number;
  sellsLastHour: number;
  priceChangeM5: number;
  priceChangeH1: number;
  priceChangeH6: number;
  priceChangeH24: number;
  pairAgeMinutes: number;
  dexScreenerUrl: string;
  /** Set during enrichment (Birdeye): token has Twitter/Telegram/website. */
  hasSocials?: boolean;
  /** Set during enrichment (Twitter API): tweets mentioning the token in the last hour. */
  tweetBuzz?: number;
}

// ---- Safety report ----

export interface SafetyReport {
  ok: boolean;
  reasons: string[];
  /** True when the failure is a transient RPC issue (rate limit, timeout)
   *  rather than an actual red flag — the caller should retry later
   *  instead of blacklisting the token. */
  transient: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  topHolderPct: number;
  decimals: number;
}

// ---- Positions ----

export type PositionStatus = "open" | "closed";

export type ExitReason =
  | "stop_loss"
  | "profit_floor"
  | "runner_trailing_stop"
  | "max_hold_time"
  | "manual";

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  status: PositionStatus;
  /** Lamports of SOL spent to open the position. */
  solSpentLamports: number;
  /** Raw token amount received (in the token's base units). */
  tokenAmountRaw: string;
  /** Raw token amount still held (decreases after partial take-profits). */
  remainingTokenRaw: string;
  /** Take-profit ladder progress: 0 = none hit, 1 = TP1 done, 2 = TP2 done,
   *  3 = TP3 done (only the runner remains). */
  tpLevel: number;
  /** Runner trailing stop level in PnL percent (ratchets up with the peak). */
  runnerStopPct?: number;
  tokenDecimals: number;
  entryPriceUsd: number;
  /** Highest price observed while the position is open (for trailing stop). */
  peakPriceUsd: number;
  openedAt: number;
  closedAt?: number;
  exitPriceUsd?: number;
  exitReason?: ExitReason;
  /** Total lamports of SOL received back (partial sells + final close). */
  solReceivedLamports?: number;
  pnlPct?: number;
  buyTxSignature?: string;
  sellTxSignature?: string;
  paper: boolean;
}

export interface BotState {
  positions: Position[];
  /** mint -> last time (ms) we exited or rejected it, for the re-entry cooldown. */
  cooldowns: Record<string, number>;
  realizedPnlSol: number;
  /** Rolling daily figures for the loss cap and the profit lock. */
  daily: {
    date: string;
    pnlSol: number;
    /** Balance (SOL) at the start of the UTC day; loss/profit percentages
     *  are computed against this reference. */
    startBalanceSol?: number;
    /** Highest daily profit percent reached (for the tiered profit lock). */
    peakProfitPct?: number;
  };
  /** Virtual SOL balance for paper trading (lamports). Set on first run from
   *  PAPER_BALANCE_EUR at the live SOL/EUR rate; buys deduct, sells credit. */
  paperBalanceLamports?: number;
  /** Whether automatic trading is enabled (controlled via Telegram). */
  tradingEnabled?: boolean;
}
