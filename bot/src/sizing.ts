/**
 * Volatility-based position sizing.
 *
 * The stake per token scales inversely with its estimated volatility:
 *   - calm, liquid, established token  -> MAX_STAKE_EUR (default 50€)
 *   - wild, thin, freshly launched one -> MIN_STAKE_EUR (default 10€)
 */
import { config } from "./config.js";
import type { TokenCandidate } from "./types.js";

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Volatility score in [0, 1] (0 = calm, 1 = extremely volatile), combining:
 *  - price movement over 5min / 1h / 6h (fast swings dominate);
 *  - pool liquidity (thin pools amplify every trade);
 *  - pair age (fresh launches are the wildest);
 *  - 24h volume / liquidity turnover (how hard the pool is being churned).
 */
export function volatilityScore(c: TokenCandidate): number {
  // |5min| swing of 15% -> saturated; |1h| of 50%; |6h| of 150%.
  const priceVol =
    clamp01(Math.abs(c.priceChangeM5) / 15) * 0.5 +
    clamp01(Math.abs(c.priceChangeH1) / 50) * 0.3 +
    clamp01(Math.abs(c.priceChangeH6) / 150) * 0.2;

  // 20k$ liquidity -> 1 (max risk), 250k$+ -> 0.
  const liquidity = clamp01((250_000 - c.liquidityUsd) / (250_000 - 20_000));

  // 30min old -> 1, 48h+ -> 0.
  const age = clamp01((48 * 60 - c.pairAgeMinutes) / (48 * 60 - 30));

  // Turnover of 10x the pool per day -> saturated.
  const turnover = clamp01(c.volume24hUsd / Math.max(c.liquidityUsd, 1) / 10);

  return clamp01(priceVol * 0.4 + liquidity * 0.25 + age * 0.2 + turnover * 0.15);
}

/** Stake in EUR for a candidate: MAX at volatility 0 down to MIN at volatility 1. */
export function stakeEurFor(c: TokenCandidate): number {
  const score = volatilityScore(c);
  const stake = config.maxStakeEur - score * (config.maxStakeEur - config.minStakeEur);
  return Math.round(stake * 100) / 100;
}
