import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { fetchJson } from "./http.js";
import { log } from "./logger.js";
import type { SafetyReport } from "./types.js";
import { getConnection } from "./wallet.js";

interface ParsedMintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: string;
}

interface RugCheckSummary {
  risks?: { name: string; description?: string; score: number; level: string }[];
  score_normalised?: number;
  lpLockedPct?: number;
}

/**
 * Holder-concentration check via on-chain data. Returns the share of supply
 * held by the largest non-LP account, or null when the RPC refuses the call
 * (the public mainnet RPC rate-limits getTokenLargestAccounts aggressively).
 */
async function getTopHolderPct(mintPubkey: PublicKey, supply: number): Promise<number | null> {
  try {
    const largest = await getConnection().getTokenLargestAccounts(mintPubkey);
    const amounts = largest.value.map((a) => Number(a.amount)).sort((a, b) => b - a);
    // The single largest account is almost always the LP vault; measure the next one.
    const secondLargest = amounts[1] ?? 0;
    return supply > 0 ? (secondLargest / supply) * 100 : null;
  } catch {
    return null;
  }
}

/**
 * Fallback risk analysis via RugCheck's free API (works without any API key).
 * Returns the list of "danger"-level risk descriptions, or null on failure.
 */
async function getRugCheckDangers(mint: string): Promise<string[] | null> {
  try {
    const summary = await fetchJson<RugCheckSummary>(
      `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`,
      { timeoutMs: 8_000, retries: 1 },
    );
    return (summary.risks ?? [])
      .filter((r) => r.level === "danger")
      .map((r) => r.description || r.name);
  } catch (err) {
    log.debug(`RugCheck lookup failed for ${mint.slice(0, 8)}…: ${String(err)}`);
    return null;
  }
}

/**
 * Anti-rug checks before every buy:
 *  1. On-chain: mint authority revoked (nobody can print new supply).
 *  2. On-chain: freeze authority revoked (nobody can freeze your tokens).
 *  3. Holder concentration below MAX_TOP_HOLDER_PCT — via RPC when allowed,
 *     otherwise via RugCheck danger-level risk flags.
 */
export async function checkTokenSafety(mint: string): Promise<SafetyReport> {
  const reasons: string[] = [];
  let transient = false;
  const mintPubkey = new PublicKey(mint);

  const accountInfo = await getConnection().getParsedAccountInfo(mintPubkey);
  const data = accountInfo.value?.data;
  if (!data || !("parsed" in data) || data.parsed.type !== "mint") {
    return {
      ok: false,
      reasons: ["mint account not found or not a token mint"],
      transient: false,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      topHolderPct: 100,
      decimals: 0,
    };
  }

  const info = data.parsed.info as ParsedMintInfo;
  const mintAuthorityRevoked = info.mintAuthority === null;
  const freezeAuthorityRevoked = info.freezeAuthority === null;
  if (!mintAuthorityRevoked) reasons.push("mint authority NOT revoked (supply can be inflated)");
  if (!freezeAuthorityRevoked) reasons.push("freeze authority NOT revoked (tokens can be frozen)");

  let topHolderPct = await getTopHolderPct(mintPubkey, Number(info.supply)) ?? -1;
  if (topHolderPct >= 0) {
    if (topHolderPct > config.maxTopHolderPct) {
      reasons.push(
        `top non-LP holder owns ${topHolderPct.toFixed(1)}% of supply ` +
          `(max ${config.maxTopHolderPct}%)`,
      );
    }
  } else {
    // RPC refused the holder query — fall back to RugCheck's risk report.
    const dangers = await getRugCheckDangers(mint);
    if (dangers === null) {
      reasons.push("could not verify holder distribution (RPC + RugCheck unavailable)");
      transient = true;
    } else if (dangers.length > 0) {
      reasons.push(`RugCheck danger flags: ${dangers.join("; ")}`);
    }
    topHolderPct = 0;
  }

  return {
    ok: reasons.length === 0,
    reasons,
    transient,
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    topHolderPct,
    decimals: info.decimals,
  };
}
