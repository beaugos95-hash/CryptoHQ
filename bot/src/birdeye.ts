import { config } from "./config.js";
import { fetchJson, HttpError } from "./http.js";
import { log } from "./logger.js";

export interface TokenSocials {
  twitter?: string;
  telegram?: string;
  website?: string;
  description?: string;
}

interface BirdeyeOverview {
  success?: boolean;
  data?: {
    symbol?: string;
    extensions?: {
      twitter?: string;
      telegram?: string;
      website?: string;
      description?: string;
    };
  };
}

const cache = new Map<string, TokenSocials | null>();
let disabledUntil = 0;

/**
 * Fetches a token's social links (Twitter, Telegram, website) from Birdeye.
 * Results are cached per mint; the client backs off when the API key's
 * compute-unit quota is exhausted. Returns null when unavailable.
 */
export async function getTokenSocials(mint: string): Promise<TokenSocials | null> {
  if (!config.birdeyeApiKey) return null;
  if (cache.has(mint)) return cache.get(mint) ?? null;
  if (Date.now() < disabledUntil) return null;

  try {
    const res = await fetchJson<BirdeyeOverview>(
      `https://public-api.birdeye.so/defi/token_overview?address=${mint}`,
      {
        timeoutMs: 8_000,
        retries: 1,
        headers: { "X-API-KEY": config.birdeyeApiKey, "x-chain": "solana" },
      },
    );
    const ext = res.data?.extensions;
    const socials: TokenSocials | null = ext
      ? {
          twitter: ext.twitter,
          telegram: ext.telegram,
          website: ext.website,
          description: ext.description,
        }
      : null;
    cache.set(mint, socials);
    return socials;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) {
      // Free tier allows ~1 req/s: short pause, retry on a later scan.
      disabledUntil = Date.now() + 60_000;
      log.debug("Birdeye rate limited, pausing enrichment for 60s");
    } else if (err instanceof HttpError && err.status === 400) {
      // "Compute units usage limit exceeded": monthly quota — long pause.
      disabledUntil = Date.now() + 10 * 60_000;
      log.warn(`Birdeye quota exhausted, pausing enrichment for 10min: ${err.message}`);
    } else {
      log.debug(`Birdeye lookup failed for ${mint.slice(0, 8)}…: ${String(err)}`);
    }
    return null;
  }
}

/** True when the token has at least one active social channel. */
export function hasSocialPresence(socials: TokenSocials | null): boolean {
  return !!socials && !!(socials.twitter || socials.telegram || socials.website);
}
