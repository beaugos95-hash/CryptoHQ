import { getTokenSocials, hasSocialPresence } from "./birdeye.js";
import { config } from "./config.js";
import { getGmgnTrendingMints } from "./gmgn.js";
import { fetchJson, sleep } from "./http.js";
import { log } from "./logger.js";
import { getTweetBuzz, twitterEnabled } from "./twitter.js";
import type { DexPair, TokenCandidate, TokenProfile } from "./types.js";
import { SOL_MINT } from "./wallet.js";

const DEXSCREENER = "https://api.dexscreener.com";

/** Trusted Solana DEXes for meme coin liquidity. */
const ALLOWED_DEXES = new Set(["raydium", "orca", "meteora", "pumpswap", "pumpfun"]);

/**
 * Collects candidate mints from DexScreener's "boosted" and "latest profiles"
 * feeds plus GMGN's trending list (best effort), all fetched in parallel.
 */
async function collectCandidateMints(): Promise<string[]> {
  const mints = new Set<string>();

  const dexscreenerSources: Promise<TokenProfile[]>[] = [
    fetchJson<TokenProfile[]>(`${DEXSCREENER}/token-boosts/latest/v1`),
    fetchJson<TokenProfile[]>(`${DEXSCREENER}/token-boosts/top/v1`),
    fetchJson<TokenProfile[]>(`${DEXSCREENER}/token-profiles/latest/v1`),
  ];

  const [dexResults, gmgnMints] = await Promise.all([
    Promise.allSettled(dexscreenerSources),
    getGmgnTrendingMints(),
  ]);

  for (const result of dexResults) {
    if (result.status === "rejected") {
      log.debug(`Discovery source failed: ${String(result.reason)}`);
      continue;
    }
    for (const profile of result.value) {
      if (profile.chainId === "solana" && profile.tokenAddress) {
        mints.add(profile.tokenAddress);
      }
    }
  }
  for (const mint of gmgnMints) mints.add(mint);
  return [...mints];
}

/** Fetches the best (most liquid) SOL-quoted pair for each mint, in batches of 30. */
async function fetchBestPairs(mints: string[]): Promise<Map<string, DexPair>> {
  const best = new Map<string, DexPair>();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const pairs = await fetchJson<{ pairs: DexPair[] | null }>(
        `${DEXSCREENER}/latest/dex/tokens/${batch.join(",")}`,
      );
      for (const pair of pairs.pairs ?? []) {
        if (pair.chainId !== "solana") continue;
        if (pair.quoteToken.address !== SOL_MINT) continue;
        const existing = best.get(pair.baseToken.address);
        if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
          best.set(pair.baseToken.address, pair);
        }
      }
    } catch (err) {
      log.warn(`Failed to fetch pair batch: ${String(err)}`);
    }
  }
  return best;
}

function pairToCandidate(pair: DexPair): TokenCandidate {
  const ageMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
  return {
    mint: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    priceUsd: Number(pair.priceUsd ?? 0),
    liquidityUsd: pair.liquidity?.usd ?? 0,
    fdvUsd: pair.fdv ?? pair.marketCap ?? 0,
    volume24hUsd: pair.volume?.h24 ?? 0,
    buysLastHour: pair.txns?.h1?.buys ?? 0,
    sellsLastHour: pair.txns?.h1?.sells ?? 0,
    priceChangeM5: pair.priceChange?.m5 ?? 0,
    priceChangeH1: pair.priceChange?.h1 ?? 0,
    priceChangeH6: pair.priceChange?.h6 ?? 0,
    priceChangeH24: pair.priceChange?.h24 ?? 0,
    pairAgeMinutes: ageMs / 60_000,
    dexScreenerUrl: pair.url,
  };
}

/** Applies all market-quality filters; returns the rejection reason or null if it passes. */
function rejectReason(c: TokenCandidate): string | null {
  if (!ALLOWED_DEXES.has(c.dexId)) return `dex ${c.dexId} not allowed`;
  if (c.priceUsd <= 0) return "no USD price";
  if (c.liquidityUsd < config.minLiquidityUsd) {
    return `liquidity $${Math.round(c.liquidityUsd)} < $${config.minLiquidityUsd}`;
  }
  if (c.fdvUsd < config.minFdvUsd) return `FDV $${Math.round(c.fdvUsd)} too low`;
  if (c.fdvUsd > config.maxFdvUsd) return `FDV $${Math.round(c.fdvUsd)} too high`;
  if (c.volume24hUsd < config.minVolume24hUsd) {
    return `24h volume $${Math.round(c.volume24hUsd)} < $${config.minVolume24hUsd}`;
  }
  if (c.pairAgeMinutes < config.minPairAgeMinutes) {
    return `pair too young (${Math.round(c.pairAgeMinutes)}min)`;
  }
  if (c.pairAgeMinutes > config.maxPairAgeHours * 60) {
    return `pair too old (${Math.round(c.pairAgeMinutes / 60)}h)`;
  }
  if (c.buysLastHour < config.minBuysLastHour) {
    return `only ${c.buysLastHour} buys in the last hour`;
  }
  if (c.sellsLastHour > 0 && c.buysLastHour / c.sellsLastHour < 1) {
    return "more sells than buys in the last hour";
  }
  if (config.requirePositiveMomentum && c.priceChangeM5 <= 0) {
    return `negative 5min momentum (${c.priceChangeM5}%)`;
  }
  return null;
}

/** Momentum score used to rank surviving candidates (higher = better). */
function score(c: TokenCandidate): number {
  const buyPressure = c.sellsLastHour > 0 ? c.buysLastHour / c.sellsLastHour : c.buysLastHour;
  const volumeToLiquidity = c.volume24hUsd / Math.max(c.liquidityUsd, 1);
  return (
    Math.min(buyPressure, 5) * 2 +
    Math.min(volumeToLiquidity, 10) +
    Math.min(Math.max(c.priceChangeM5, 0), 30) / 3 +
    Math.min(Math.max(c.priceChangeH1, 0), 100) / 20
  );
}

/**
 * Enriches the top candidates with social data and applies score bonuses:
 *  - Birdeye: does the token have an active Twitter/Telegram/website?
 *  - Twitter API (when a bearer token is configured): tweet buzz over
 *    the last hour, which catches coordinated token "drops".
 */
async function enrichTopCandidates(candidates: TokenCandidate[]): Promise<void> {
  // Sequential with a small gap: Birdeye's free tier allows ~1 request/s.
  const top = candidates.slice(0, 5);
  for (const [index, candidate] of top.entries()) {
    const socials = await getTokenSocials(candidate.mint);
    if (socials !== null) candidate.hasSocials = hasSocialPresence(socials);
    if (twitterEnabled()) {
      const buzz = await getTweetBuzz(candidate.symbol, candidate.mint);
      if (buzz !== null) candidate.tweetBuzz = buzz;
    }
    if (index < top.length - 1) await sleep(1_100);
  }
}

/** Bonus applied on top of the market-based score. */
function socialBonus(c: TokenCandidate): number {
  let bonus = 0;
  if (c.hasSocials) bonus += config.socialScoreBonus;
  if (c.tweetBuzz !== undefined) bonus += Math.min(c.tweetBuzz / 20, config.socialScoreBonus * 2);
  return bonus;
}

/**
 * Full discovery pass: trending mints (DexScreener + GMGN) -> best SOL pairs
 * -> filters -> social enrichment (Birdeye/Twitter) -> ranked candidates.
 */
export async function discoverCandidates(): Promise<TokenCandidate[]> {
  const mints = await collectCandidateMints();
  if (mints.length === 0) {
    log.debug("No candidate mints from discovery feeds");
    return [];
  }
  log.debug(`Discovery: ${mints.length} trending mints found`);

  const pairs = await fetchBestPairs(mints);
  const candidates: TokenCandidate[] = [];
  for (const pair of pairs.values()) {
    const candidate = pairToCandidate(pair);
    const reason = rejectReason(candidate);
    if (reason) {
      log.debug(`Rejected ${candidate.symbol} (${candidate.mint.slice(0, 8)}…): ${reason}`);
    } else {
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => score(b) - score(a));
  await enrichTopCandidates(candidates);
  candidates.sort((a, b) => score(b) + socialBonus(b) - (score(a) + socialBonus(a)));

  if (candidates.length > 0) {
    log.info(
      `Discovery: ${candidates.length}/${pairs.size} candidates passed filters`,
      { top: candidates.slice(0, 3).map((c) => c.symbol) },
    );
  }
  return candidates;
}

/** Builds a candidate for a specific mint (used by the Telegram /buy command). */
export async function getCandidateByMint(mint: string): Promise<TokenCandidate | null> {
  const pairs = await fetchBestPairs([mint]);
  const pair = pairs.get(mint);
  return pair ? pairToCandidate(pair) : null;
}

/** Fetches the current USD price of a token from its most liquid pair. */
export async function getTokenPriceUsd(mint: string): Promise<number | null> {
  try {
    const res = await fetchJson<{ pairs: DexPair[] | null }>(
      `${DEXSCREENER}/latest/dex/tokens/${mint}`,
      { retries: 2 },
    );
    let bestPair: DexPair | undefined;
    for (const pair of res.pairs ?? []) {
      if (pair.chainId !== "solana" || !pair.priceUsd) continue;
      if (!bestPair || (pair.liquidity?.usd ?? 0) > (bestPair.liquidity?.usd ?? 0)) {
        bestPair = pair;
      }
    }
    return bestPair ? Number(bestPair.priceUsd) : null;
  } catch (err) {
    log.warn(`Price fetch failed for ${mint.slice(0, 8)}…: ${String(err)}`);
    return null;
  }
}
