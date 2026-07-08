import { fetchJson } from "./http.js";
import { log } from "./logger.js";

interface CoinGeckoPrice {
  solana?: { eur?: number; usd?: number };
}

let cached: { eurPerSol: number; usdPerSol: number; at: number } | undefined;
const TTL_MS = 5 * 60_000;

/** SOL price in EUR and USD, cached for 5 minutes (CoinGecko free API). */
export async function getSolRates(): Promise<{ eurPerSol: number; usdPerSol: number }> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached;
  try {
    const res = await fetchJson<CoinGeckoPrice>(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=eur,usd",
      { timeoutMs: 8_000, retries: 2 },
    );
    const eur = res.solana?.eur;
    const usd = res.solana?.usd;
    if (!eur || !usd) throw new Error("missing solana price in response");
    cached = { eurPerSol: eur, usdPerSol: usd, at: Date.now() };
    return cached;
  } catch (err) {
    if (cached) {
      log.warn(`SOL rate refresh failed, using stale rate: ${String(err)}`);
      return cached;
    }
    throw new Error(`Cannot fetch SOL/EUR rate: ${String(err)}`);
  }
}

export function solToEur(sol: number, eurPerSol: number): string {
  return `${(sol * eurPerSol).toFixed(2)}€`;
}
