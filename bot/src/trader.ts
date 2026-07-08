import { randomUUID } from "node:crypto";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "./config.js";
import { discoverCandidates, getTokenPriceUsd } from "./discovery.js";
import { log } from "./logger.js";
import { notify } from "./notify.js";
import { checkTokenSafety } from "./safety.js";
import { getQuote, executeSwap } from "./jupiter.js";
import { loadState, saveState, todayUtc } from "./state.js";
import type { BotState, ExitReason, Position, TokenCandidate } from "./types.js";
import { SOL_MINT } from "./wallet.js";

export class Trader {
  private readonly state: BotState;
  /** UTC date for which the daily-loss pause was already announced. */
  private dailyPauseAnnouncedFor = "";

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

  /** Books realized PnL both globally and in the rolling daily counter. */
  private addRealizedPnl(pnlSol: number): void {
    this.state.realizedPnlSol += pnlSol;
    const today = todayUtc();
    if (this.state.daily.date !== today) {
      this.state.daily = { date: today, pnlSol: 0 };
    }
    this.state.daily.pnlSol += pnlSol;
  }

  /** True when the daily loss cap is hit: no new buys for the rest of the UTC day. */
  private isDailyLossCapHit(): boolean {
    if (config.maxDailyLossSol <= 0) return false;
    const today = todayUtc();
    if (this.state.daily.date !== today) return false;
    const hit = this.state.daily.pnlSol <= -config.maxDailyLossSol;
    if (hit && this.dailyPauseAnnouncedFor !== today) {
      this.dailyPauseAnnouncedFor = today;
      const message =
        `Daily loss cap hit (${this.state.daily.pnlSol.toFixed(4)} SOL <= ` +
        `-${config.maxDailyLossSol} SOL): pausing new buys until tomorrow UTC. ` +
        `Open positions are still monitored.`;
      log.warn(message);
      notify(`⛔ ${message}`);
    }
    return hit;
  }

  // ---- Entry ----

  /** One discovery pass: finds candidates and opens positions if slots are free. */
  async scanAndBuy(): Promise<void> {
    if (this.isDailyLossCapHit()) return;
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

  /**
   * Honeypot guard: verify a sell route exists for the amount we are about to
   * hold, and that an immediate buy+sell round trip would not lose more than
   * MAX_ROUND_TRIP_LOSS_PCT (high hidden taxes, one-sided liquidity…).
   */
  private async assertSellable(mint: string, tokenAmountRaw: string, solInLamports: bigint) {
    let solBackLamports: number;
    try {
      const reverseQuote = await getQuote(mint, SOL_MINT, BigInt(tokenAmountRaw));
      solBackLamports = Number(reverseQuote.outAmount);
    } catch (err) {
      throw new Error(`no sell route — possible honeypot (${String(err)})`);
    }
    const roundTripLossPct = (1 - solBackLamports / Number(solInLamports)) * 100;
    if (roundTripLossPct > config.maxRoundTripLossPct) {
      throw new Error(
        `round-trip loss ${roundTripLossPct.toFixed(1)}% exceeds ` +
          `${config.maxRoundTripLossPct}% — possible honeypot or hidden tax`,
      );
    }
  }

  private async openPosition(candidate: TokenCandidate, decimals: number): Promise<void> {
    const lamports = BigInt(Math.round(config.buyAmountSol * LAMPORTS_PER_SOL));

    const quote = await getQuote(SOL_MINT, candidate.mint, lamports);
    const priceImpact = Math.abs(Number(quote.priceImpactPct)) * 100;
    if (priceImpact > config.slippageBps / 100) {
      throw new Error(`price impact ${priceImpact.toFixed(2)}% exceeds slippage budget`);
    }

    if (config.honeypotCheck) {
      await this.assertSellable(candidate.mint, quote.outAmount, lamports);
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
      remainingTokenRaw: quote.outAmount,
      tp1Done: false,
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
    notify(
      `🟢 ${config.dryRun ? "[PAPER] " : ""}BUY ${candidate.symbol} — ` +
        `${config.buyAmountSol} SOL @ $${candidate.priceUsd}\n${candidate.dexScreenerUrl}`,
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

      // TP1: lock in part of the profit, let the rest ride under the trailing stop.
      if (config.tp1Pct > 0 && !position.tp1Done && pnlPct >= config.tp1Pct) {
        try {
          await this.partialTakeProfit(position, pnlPct);
        } catch (err) {
          log.error(`TP1 sell failed for ${position.symbol}: ${String(err)} — will retry`);
        }
        continue; // re-evaluate full exits on the next tick
      }

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

  /** Sells a token amount for SOL (real swap, or simulated fill in paper mode). */
  private async sellTokens(
    position: Position,
    tokenAmountRaw: bigint,
    pricePnlPct: number,
  ): Promise<{ solReceivedLamports: number; signature?: string }> {
    // Cost basis of the sold chunk, proportional to the original bag.
    const soldFraction = Number(tokenAmountRaw) / Number(position.tokenAmountRaw);
    if (config.dryRun) {
      const costBasis = position.solSpentLamports * soldFraction;
      return { solReceivedLamports: Math.round(costBasis * (1 + pricePnlPct / 100)) };
    }
    const quote = await getQuote(position.mint, SOL_MINT, tokenAmountRaw);
    const signature = await executeSwap(quote);
    return { solReceivedLamports: Number(quote.outAmount), signature };
  }

  /** TP1: sell a fraction of the bag and keep the rest running. */
  private async partialTakeProfit(position: Position, pnlPct: number): Promise<void> {
    const remaining = BigInt(position.remainingTokenRaw);
    const toSell = (remaining * BigInt(Math.round(config.tp1SellFraction * 10_000))) / 10_000n;
    if (toSell <= 0n) {
      position.tp1Done = true;
      return;
    }

    const { solReceivedLamports, signature } = await this.sellTokens(position, toSell, pnlPct);

    const costBasis =
      position.solSpentLamports * (Number(toSell) / Number(position.tokenAmountRaw));
    const pnlSol = (solReceivedLamports - costBasis) / LAMPORTS_PER_SOL;

    position.remainingTokenRaw = (remaining - toSell).toString();
    position.tp1Done = true;
    position.solReceivedLamports = (position.solReceivedLamports ?? 0) + solReceivedLamports;
    if (signature) position.sellTxSignature = signature;
    this.addRealizedPnl(pnlSol);
    saveState(this.state);

    const message =
      `${position.paper ? "[PAPER] " : ""}TP1 ${position.symbol} — sold ` +
      `${Math.round(config.tp1SellFraction * 100)}% at +${pnlPct.toFixed(1)}% ` +
      `(+${pnlSol.toFixed(4)} SOL locked in), letting the rest ride`;
    log.info(message);
    notify(`🟡 ${message}`);
  }

  private async closePosition(
    position: Position,
    priceUsd: number,
    reason: ExitReason,
  ): Promise<void> {
    const pricePnlPct = ((priceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;

    const { solReceivedLamports, signature } = await this.sellTokens(
      position,
      BigInt(position.remainingTokenRaw),
      pricePnlPct,
    );

    const costBasis =
      position.solSpentLamports *
      (Number(position.remainingTokenRaw) / Number(position.tokenAmountRaw));
    const pnlSol = (solReceivedLamports - costBasis) / LAMPORTS_PER_SOL;

    const totalReceived = (position.solReceivedLamports ?? 0) + solReceivedLamports;
    position.status = "closed";
    position.closedAt = Date.now();
    position.exitPriceUsd = priceUsd;
    position.exitReason = reason;
    if (signature) position.sellTxSignature = signature;
    position.remainingTokenRaw = "0";
    position.solReceivedLamports = totalReceived;
    // Overall economic result of the position (partials included).
    position.pnlPct = ((totalReceived - position.solSpentLamports) / position.solSpentLamports) * 100;

    this.addRealizedPnl(pnlSol);
    this.setCooldown(position.mint);
    saveState(this.state);

    const sign = (v: number) => (v >= 0 ? "+" : "");
    const message =
      `${position.paper ? "[PAPER] " : ""}SELL ${position.symbol} — ${reason} — ` +
      `${sign(position.pnlPct)}${position.pnlPct.toFixed(1)}% on the position — ` +
      `today: ${sign(this.state.daily.pnlSol)}${this.state.daily.pnlSol.toFixed(4)} SOL, ` +
      `total: ${sign(this.state.realizedPnlSol)}${this.state.realizedPnlSol.toFixed(4)} SOL`;
    log.info(message);
    notify(`${position.pnlPct >= 0 ? "🟢" : "🔴"} ${message}`);
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
