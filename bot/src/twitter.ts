import { config } from "./config.js";
import { fetchJson, HttpError } from "./http.js";
import { log } from "./logger.js";

interface TweetCountsResponse {
  meta?: { total_tweet_count?: number };
}

const cache = new Map<string, { count: number; at: number }>();
const TTL_MS = 10 * 60_000;
let disabledUntil = 0;

/** True when the Twitter module is active (requires a paid API v2 bearer token). */
export function twitterEnabled(): boolean {
  return config.twitterBearerToken !== "";
}

/**
 * Number of tweets mentioning the token in the last hour ("buzz").
 * Uses the Twitter API v2 recent counts endpoint; searches both the cashtag
 * form ($SYMBOL) and the raw mint address (contract-address drops).
 * Returns null when the module is disabled or the API fails.
 */
export async function getTweetBuzz(symbol: string, mint: string): Promise<number | null> {
  if (!twitterEnabled() || Date.now() < disabledUntil) return null;

  const cached = cache.get(mint);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.count;

  const query = encodeURIComponent(`("$${symbol}" OR "${mint}") -is:retweet`);
  const start = new Date(Date.now() - 60 * 60_000).toISOString();
  try {
    const res = await fetchJson<TweetCountsResponse>(
      `https://api.x.com/2/tweets/counts/recent?query=${query}&start_time=${start}&granularity=hour`,
      {
        timeoutMs: 8_000,
        retries: 1,
        headers: { authorization: `Bearer ${config.twitterBearerToken}` },
      },
    );
    const count = res.meta?.total_tweet_count ?? 0;
    cache.set(mint, { count, at: Date.now() });
    return count;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      disabledUntil = Number.MAX_SAFE_INTEGER;
      log.warn(`Twitter API rejected the bearer token (${err.status}) — module disabled`);
    } else if (err instanceof HttpError && err.status === 429) {
      disabledUntil = Date.now() + 15 * 60_000;
      log.warn("Twitter API rate limited — pausing buzz lookups for 15min");
    } else {
      log.debug(`Twitter buzz lookup failed for ${symbol}: ${String(err)}`);
    }
    return null;
  }
}
