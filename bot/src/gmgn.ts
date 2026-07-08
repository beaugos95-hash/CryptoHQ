import { config } from "./config.js";
import { log } from "./logger.js";

interface GmgnRankItem {
  address?: string;
  chain?: string;
}

interface GmgnRankResponse {
  data?: { rank?: GmgnRankItem[] };
}

let disabled = false;
let failureCount = 0;

/**
 * Best-effort GMGN trending feed.
 *
 * gmgn.ai has no official public API and sits behind Cloudflare bot
 * protection, so server-side requests are often rejected (HTTP 403).
 * We try anyway with browser-like headers; after 3 consecutive failures the
 * source disables itself for the session and discovery continues with
 * DexScreener + Birdeye alone.
 */
export async function getGmgnTrendingMints(): Promise<string[]> {
  if (!config.gmgnEnabled || disabled) return [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(
      "https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=swaps&direction=desc",
      {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Accept: "application/json",
          Referer: "https://gmgn.ai/",
        },
      },
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as GmgnRankResponse;
    const mints = (body.data?.rank ?? [])
      .filter((item) => item.address && (item.chain === undefined || item.chain === "sol"))
      .map((item) => item.address as string);
    failureCount = 0;
    if (mints.length > 0) log.debug(`GMGN: ${mints.length} trending mints`);
    return mints;
  } catch (err) {
    failureCount++;
    if (failureCount >= 3) {
      disabled = true;
      log.warn(
        `GMGN feed unavailable (${String(err)}) — disabled for this session, ` +
          `continuing with DexScreener + Birdeye`,
      );
    } else {
      log.debug(`GMGN fetch failed (${failureCount}/3): ${String(err)}`);
    }
    return [];
  }
}
