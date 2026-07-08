import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import { log } from "./logger.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

let connection: Connection | undefined;
let keypair: Keypair | undefined;

export function getConnection(): Connection {
  if (!connection) {
    // disableRetryOnRateLimit: we handle 429s ourselves (transient skip +
    // retry on the next scan) instead of web3.js blocking the loop.
    connection = new Connection(config.rpcUrl, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    });
  }
  return connection;
}

/** Returns the trading keypair, or undefined in paper mode without a key. */
export function getKeypair(): Keypair | undefined {
  if (keypair) return keypair;
  if (!config.privateKey) return undefined;
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(config.privateKey));
    return keypair;
  } catch {
    throw new Error("PRIVATE_KEY is not a valid base58-encoded Solana secret key");
  }
}

export async function checkWalletBalance(): Promise<void> {
  const kp = getKeypair();
  if (!kp) return;
  const lamports = await getConnection().getBalance(kp.publicKey);
  const sol = lamports / LAMPORTS_PER_SOL;
  log.info(`Wallet ${kp.publicKey.toBase58()} balance: ${sol.toFixed(4)} SOL`);
  const needed = config.buyAmountSol * config.maxOpenPositions + 0.05;
  if (!config.dryRun && sol < needed) {
    log.warn(
      `Balance may be insufficient: ${sol.toFixed(4)} SOL available, ` +
        `~${needed.toFixed(4)} SOL recommended (buys + fees)`,
    );
  }
}
