import { VersionedTransaction } from "@solana/web3.js";
import { config } from "./config.js";
import { fetchJson } from "./http.js";
import { log } from "./logger.js";
import { getConnection, getKeypair } from "./wallet.js";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [key: string]: unknown;
}

interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

/** Gets the best route quote from Jupiter for an exact-in swap. */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: bigint,
): Promise<JupiterQuote> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountRaw.toString(),
    slippageBps: config.slippageBps.toString(),
    swapMode: "ExactIn",
  });
  return fetchJson<JupiterQuote>(`${config.jupiterBaseUrl}/swap/v1/quote?${params}`, {
    timeoutMs: 8_000,
    retries: 2,
  });
}

/**
 * Builds, signs, sends and confirms a swap transaction for the given quote.
 * Throws if the transaction is not confirmed. Never called in dry-run mode.
 */
export async function executeSwap(quote: JupiterQuote): Promise<string> {
  const keypair = getKeypair();
  if (!keypair) throw new Error("No keypair available for live trading");

  const swap = await fetchJson<SwapResponse>(`${config.jupiterBaseUrl}/swap/v1/swap`, {
    method: "POST",
    timeoutMs: 10_000,
    retries: 1,
    body: {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      computeUnitPriceMicroLamports: config.priorityFeeMicroLamports,
    },
  });

  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  tx.sign([keypair]);

  const connection = getConnection();
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  log.info(`Swap sent: ${signature}`);

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(`Swap ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }
  log.info(`Swap confirmed: ${signature}`);
  return signature;
}
