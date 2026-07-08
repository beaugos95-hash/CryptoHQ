import { randomUUID } from "node:crypto";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "./config.js";
import { discoverCandidates, getTokenPriceUsd } from "./discovery.js";
import { log } from "./logger.js";
import { checkTokenSafety } from "./safety.js";
import { getQuote, executeSwap } from "./jupiter.js";
import { loadState, saveState } from "./state.js";
import type { BotState, ExitReason, Position, TokenCandidate } from "./types.js";
import { SOL_MINT } from "./wallet.js";

export class Trader {
  private readonly state: BotState;

  constructor() {
    this.state = loadState();
  }

  get openPositions(): Position[] {
    return this.state.positions.filter((p) => p.status === "open");
  }

  private isOnCooldown(mint: string): boolean {
    const last = this.state.cooldowns[mint];
    return last !== undefined && Date.now() - last < config.reentryCooldownMinutes * 60_000;
  }

  private setCooldown(mint: string): void {
    this.state.cooldowns[mint] = Date.now();
    // Prune expired entries so the map never grows unbounded.
    const cutoff = Date.now() - config.reentryCooldownMinutes * 60_000;
    for (const [key, ts] of Object.entries(this.state.cooldowns)) {
      if (ts < cutoff) delete this.state.cooldowns[key];
    }
  }

  // ---- Entry ----

  /** One discovery pass: finds candidates and opens positions if slots are free. */
  async scanAndBuy(): Promise<void> {
    const freeSlots = config.maxOpenPositions - this.openPositions.length;
    if (freeSlots <= 0) return;

    const candidates = await discoverCandidates();
    let opened = 0;
    // Cap on-chain safety checks per scan so a public RPC's rate limit
    // is never exhausted by a single discovery pass.
    let safetyChecksLeft = Math.max(freeSlots * 2, 4);

    for (const candidate of candidates) {
      if (opened >= freeSlots || safetyChecksLeft <= 0) break;
      if (this.isOnCooldown(candidate.mint)) continue;
      if (this.openPositions.some((p) => p.mint === candidate.mint)) continue;

      safetyChecksLeft--;
      const safety = await checkTokenSafety(candidate.mint).catch((err) => {
        log.warn(`Safety check errored for ${candidate.symbol}: ${String(err)}`);
        return null;
      });
      if (!safety) continue;
      if (!safety.ok) {
        log.info(`SKIP ${candidate.symbol}: ${safety.reasons.join("; ")}`);
        // Real red flags blacklist the token for the cooldown window;
        // transient RPC errors leave it eligible for the next scan.
        if (!safety.transient) this.setCooldown(candidate.mint);
        continue;
      }

      try {
        await this.openPosition(candidate, safety.decimals);
        opened++;
      } catch (err) {
        log.error(`Buy failed for ${candidate.symbol}: ${String(err)}`);
        this.setCooldown(candidate.mint);
      }
    }
    saveState(this.state);
  }

  private async openPosition(candidate: TokenCandidate, decimals: number): Promise<void> {
    const lamports = BigInt(Math.round(config.buyAmountSol * LAMPORTS_PER_SOL));

    const quote = await getQuote(SOL_MINT, candidate.mint, lamports);
    const priceImpact = Math.abs(Number(quote.priceImpactPct)) * 100;
    if (priceImpact > config.slippageBps / 100) {
      throw new Error(`price impact ${priceImpact.toFixed(2)}% exceeds slippage budget`);
    }

    let signature: string | undefined;
    if (!config.dryRun) {
      signature = await executeSwap(quote);
    }

    const position: Position = {
      id: randomUUID(),
      mint: candidate.mint,
      symbol: candidate.symbol,
      status: "open",
      solSpentLamports: Number(lamports),
      tokenAmountRaw: quote.outAmount,
      tokenDecimals: decimals,
      entryPriceUsd: candidate.priceUsd,
      peakPriceUsd: candidate.priceUsd,
      openedAt: Date.now(),
      buyTxSignature: signature,
      paper: config.dryRun,
    };
    this.state.positions.push(position);
    saveState(this.state);

    log.info(
      `${config.dryRun ? "[PAPER] " : ""}BUY ${candidate.symbol} — ` +
        `${config.buyAmountSol} SOL @ $${candidate.priceUsd} ` +
        `(liq $${Math.round(candidate.liquidityUsd)}, FDV $${Math.round(candidate.fdvUsd)})`,
      { mint: candidate.mint, url: candidate.dexScreenerUrl },
    );
  }

  // ---- Exit ----

  /** One monitoring pass: checks every open position against exit rules. */
  async monitorPositions(): Promise<void> {
    for (const position of this.openPositions) {
      const price = await getTokenPriceUsd(position.mint);
      if (price === null || price <= 0) continue;

      if (price > position.peakPriceUsd) {
        position.peakPriceUsd = price;
      }

      const pnlPct = ((price - position.entryPriceUsd) / position.entryPriceUsd) * 100;
      const drawdownFromPeakPct =
        ((position.peakPriceUsd - price) / position.peakPriceUsd) * 100;
      const heldMinutes = (Date.now() - position.openedAt) / 60_000;

      let exitReason: ExitReason | undefined;
      if (pnlPct >= config.takeProfitPct) exitReason = "take_profit";
      else if (pnlPct <= -config.stopLossPct) exitReason = "stop_loss";
      else if (
        config.trailingStopPct > 0 &&
        pnlPct > 0 &&
        drawdownFromPeakPct >= config.trailingStopPct
      ) {
        exitReason = "trailing_stop";
      } else if (config.maxHoldMinutes > 0 && heldMinutes >= config.maxHoldMinutes) {
        exitReason = "max_hold_time";
      }

      if (exitReason) {
        try {
          await this.closePosition(position, price, exitReason);
        } catch (err) {
          log.error(`Sell failed for ${position.symbol}: ${String(err)} — will retry`);
        }
      } else {
        log.debug(
          `${position.symbol}: $${price} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%, ` +
            `peak drawdown ${drawdownFromPeakPct.toFixed(1)}%, held ${heldMinutes.toFixed(0)}min)`,
        );
      }
    }
    saveState(this.state);
  }

  private async closePosition(
    position: Position,
    priceUsd: number,
    reason: ExitReason,
  ): Promise<void> {
    const pnlPct = ((priceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;

    let signature: string | undefined;
    let solReceivedLamports: number;

    if (config.dryRun) {
      // Paper fill: value the position at the observed price ratio.
      solReceivedLamports = Math.round(position.solSpentLamports * (1 + pnlPct / 100));
    } else {
      const quote = await getQuote(position.mint, SOL_MINT, BigInt(position.tokenAmountRaw));
      signature = await executeSwap(quote);
      solReceivedLamports = Number(quote.outAmount);
    }

    position.status = "closed";
    position.closedAt = Date.now();
    position.exitPriceUsd = priceUsd;
    position.exitReason = reason;
    position.sellTxSignature = signature;
    position.solReceivedLamports = solReceivedLamports;
    position.pnlPct = pnlPct;

    const pnlSol = (solReceivedLamports - position.solSpentLamports) / LAMPORTS_PER_SOL;
    this.state.realizedPnlSol += pnlSol;
    this.setCooldown(position.mint);
    saveState(this.state);

    log.info(
      `${position.paper ? "[PAPER] " : ""}SELL ${position.symbol} — ${reason} — ` +
        `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL) — ` +
        `total realized PnL: ${this.state.realizedPnlSol.toFixed(4)} SOL`,
    );
  }

  /** Summary printed on shutdown. */
  printSummary(): void {
    const closed = this.state.positions.filter((p) => p.status === "closed");
    const wins = closed.filter((p) => (p.pnlPct ?? 0) > 0).length;
    log.info(
      `Session summary: ${closed.length} closed trades (${wins} wins), ` +
        `${this.openPositions.length} still open, ` +
        `realized PnL ${this.state.realizedPnlSol.toFixed(4)} SOL`,
    );
  }
}
