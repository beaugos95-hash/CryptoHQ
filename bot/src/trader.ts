import { randomUUID } from "node:crypto";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "./config.js";
import { discoverCandidates, getCandidateByMint, getTokenPriceUsd } from "./discovery.js";
import { getSolRates } from "./fx.js";
import { log } from "./logger.js";
import { notify } from "./notify.js";
import { checkTokenSafety } from "./safety.js";
import { getQuote, executeSwap } from "./jupiter.js";
import { loadState, saveState, todayUtc } from "./state.js";
import type { BotState, ExitReason, Position, TokenCandidate } from "./types.js";
import { SOL_MINT } from "./wallet.js";

export class Trader {
  readonly state: BotState;
  /** UTC date for which a daily pause (loss cap / profit lock) was announced. */
  private dailyPauseAnnouncedFor = "";
  /** Live-mode wallet balance snapshot (SOL), refreshed at startup. */
  private walletBalanceSol = 0;

  constructor() {
    this.state = loadState();
    this.state.tradingEnabled ??= config.autostart;
  }

  /**
   * One-time async setup: funds the paper wallet from PAPER_BALANCE_EUR at
   * the live SOL/EUR rate on the very first run, and records the day-start
   * balance used by the daily loss cap and profit lock.
   */
  async init(): Promise<void> {
    if (config.dryRun && this.state.paperBalanceLamports === undefined) {
      const { eurPerSol } = await getSolRates();
      const sol = config.paperBalanceEur / eurPerSol;
      this.state.paperBalanceLamports = Math.round(sol * LAMPORTS_PER_SOL);
      saveState(this.state);
      log.info(
        `Paper wallet funded: ${config.paperBalanceEur}€ = ${sol.toFixed(4)} SOL ` +
          `(1 SOL = ${eurPerSol.toFixed(2)}€)`,
      );
    }
    if (!config.dryRun) {
      const { getConnection, getKeypair } = await import("./wallet.js");
      const keypair = getKeypair();
      if (keypair) {
        this.walletBalanceSol =
          (await getConnection().getBalance(keypair.publicKey)) / LAMPORTS_PER_SOL;
      }
    }
    if (this.state.daily.startBalanceSol === undefined) {
      this.state.daily.startBalanceSol = this.currentEquitySol();
      saveState(this.state);
    }
  }

  /**
   * Estimated total equity in SOL: free balance plus the cost basis still
   * deployed in open positions. Reference for the daily percentage rules.
   */
  private currentEquitySol(): number {
    const deployedLamports = this.openPositions.reduce(
      (sum, p) =>
        sum + p.solSpentLamports * (Number(p.remainingTokenRaw) / Number(p.tokenAmountRaw)),
      0,
    );
    const freeSol = config.dryRun
      ? this.paperBalanceLamports / LAMPORTS_PER_SOL
      : this.walletBalanceSol;
    return freeSol + deployedLamports / LAMPORTS_PER_SOL;
  }

  get openPositions(): Position[] {
    return this.state.positions.filter((p) => p.status === "open");
  }

  get tradingEnabled(): boolean {
    return this.state.tradingEnabled ?? true;
  }

  setTradingEnabled(enabled: boolean): void {
    this.state.tradingEnabled = enabled;
    saveState(this.state);
    log.info(`Automatic trading ${enabled ? "ENABLED" : "PAUSED"} (via Telegram)`);
  }

  /** Paper wallet balance in lamports (paper mode only). */
  get paperBalanceLamports(): number {
    return this.state.paperBalanceLamports ?? 0;
  }

  private adjustPaperBalance(deltaLamports: number): void {
    if (!config.dryRun) return;
    this.state.paperBalanceLamports = Math.max(0, this.paperBalanceLamports + deltaLamports);
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

  /** Resets the daily counters when the UTC day changes. */
  private rollDailyIfNeeded(): void {
    const today = todayUtc();
    if (this.state.daily.date !== today) {
      this.state.daily = {
        date: today,
        pnlSol: 0,
        startBalanceSol: this.currentEquitySol(),
        peakProfitPct: 0,
      };
    }
  }

  /** Books realized PnL both globally and in the rolling daily counter. */
  private addRealizedPnl(pnlSol: number): void {
    this.state.realizedPnlSol += pnlSol;
    this.rollDailyIfNeeded();
    this.state.daily.pnlSol += pnlSol;
  }

  /** Day's realized PnL as a percentage of the day-start balance. */
  private dailyProfitPct(): number {
    const reference = this.state.daily.startBalanceSol ?? 0;
    if (reference <= 0) return 0;
    return (this.state.daily.pnlSol / reference) * 100;
  }

  private announceDailyPause(message: string): void {
    const today = todayUtc();
    if (this.dailyPauseAnnouncedFor === today) return;
    this.dailyPauseAnnouncedFor = today;
    log.warn(message);
    notify(`⛔ ${message}`);
  }

  /**
   * Daily circuit breakers — both stop NEW buys for the rest of the UTC day
   * (open positions are always still monitored and can exit):
   *  1. Loss cap: the day's realized loss reaches MAX_DAILY_LOSS_PCT of the
   *     day-start balance.
   *  2. Tiered profit lock: once the day's profit reached
   *     DAILY_PROFIT_LOCK_PCT, it must stay above the last
   *     DAILY_PROFIT_TIER_PCT tier below the day's peak (e.g. peak +45%,
   *     tier 5 -> stop for the day if profit drops below +40%).
   */
  private isDailyStopHit(): boolean {
    this.rollDailyIfNeeded();
    const profitPct = this.dailyProfitPct();

    if (config.maxDailyLossPct > 0 && profitPct <= -config.maxDailyLossPct) {
      this.announceDailyPause(
        `Daily loss cap hit (${profitPct.toFixed(1)}% <= -${config.maxDailyLossPct}% ` +
          `of the day-start balance): pausing new buys until tomorrow UTC.`,
      );
      return true;
    }

    if (config.dailyProfitLockPct > 0) {
      const peak = Math.max(this.state.daily.peakProfitPct ?? 0, profitPct);
      this.state.daily.peakProfitPct = peak;
      if (peak >= config.dailyProfitLockPct) {
        const tier = config.dailyProfitTierPct;
        const floor = Math.floor(peak / tier) * tier - tier;
        if (profitPct < floor) {
          this.announceDailyPause(
            `Daily profit lock: peak +${peak.toFixed(1)}%, profit fell to ` +
              `+${profitPct.toFixed(1)}% (< +${floor}% floor). Locking in gains — ` +
              `no new buys until tomorrow UTC.`,
          );
          return true;
        }
      }
    }
    return false;
  }

  // ---- Entry ----

  /** One discovery pass: finds candidates and opens positions if slots are free. */
  async scanAndBuy(): Promise<void> {
    if (!this.tradingEnabled) return;
    if (this.isDailyStopHit()) return;
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
    if (config.dryRun && this.paperBalanceLamports < Number(lamports)) {
      throw new Error(
        `insufficient paper balance (${(this.paperBalanceLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)`,
      );
    }

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
      tpLevel: 0,
      tokenDecimals: decimals,
      entryPriceUsd: candidate.priceUsd,
      peakPriceUsd: candidate.priceUsd,
      openedAt: Date.now(),
      buyTxSignature: signature,
      paper: config.dryRun,
    };
    this.state.positions.push(position);
    this.adjustPaperBalance(-Number(lamports));
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

  // ---- Exit: take-profit ladder ----
  //
  // Level 0 (no TP hit): hard stop at -STOP_LOSS_PCT, timeout at MAX_HOLD_MINUTES.
  //   -> at +TP1_PCT: sell 50%, stop moves UP to +TP1_FLOOR_PCT.
  // Level 1: exit everything if PnL falls back to +TP1_FLOOR_PCT.
  //   -> at +TP2_PCT: sell 50% of what remains, stop moves up to +TP2_FLOOR_PCT.
  // Level 2: exit everything if PnL falls back to +TP2_FLOOR_PCT.
  //   -> at +TP3_PCT: sell everything except RUNNER_KEEP_FRACTION.
  // Level 3 (runner): no upper target; a trailing stop follows the peak PnL
  //   at RUNNER_TRAIL_PCT points below it and only ever moves up.

  /** One monitoring pass: checks every open position against the ladder. */
  async monitorPositions(): Promise<void> {
    for (const position of this.openPositions) {
      const price = await getTokenPriceUsd(position.mint);
      if (price === null || price <= 0) continue;

      if (price > position.peakPriceUsd) {
        position.peakPriceUsd = price;
      }

      const entry = position.entryPriceUsd;
      const pnlPct = ((price - entry) / entry) * 100;
      const peakPnlPct = ((position.peakPriceUsd - entry) / entry) * 100;
      const heldMinutes = (Date.now() - position.openedAt) / 60_000;

      // ---- Ladder triggers (partial sells) ----
      try {
        if (position.tpLevel === 0 && pnlPct >= config.tp1Pct) {
          await this.ladderSell(position, 0.5, 1, pnlPct, `stop verrouillé à +${config.tp1FloorPct}%`);
          continue;
        }
        if (position.tpLevel === 1 && pnlPct >= config.tp2Pct) {
          await this.ladderSell(position, 0.5, 2, pnlPct, `stop verrouillé à +${config.tp2FloorPct}%`);
          continue;
        }
        if (position.tpLevel === 2 && pnlPct >= config.tp3Pct) {
          await this.ladderSell(
            position,
            1 - config.runnerKeepFraction,
            3,
            pnlPct,
            `runner ${Math.round(config.runnerKeepFraction * 100)}% avec trailing stop`,
          );
          position.runnerStopPct = pnlPct - config.runnerTrailPct;
          saveState(this.state);
          continue;
        }
      } catch (err) {
        log.error(`TP sell failed for ${position.symbol}: ${String(err)} — will retry`);
        continue;
      }

      // ---- Stop rules per ladder level ----
      let exitReason: ExitReason | undefined;
      if (position.tpLevel === 0) {
        if (pnlPct <= -config.stopLossPct) exitReason = "stop_loss";
        else if (config.maxHoldMinutes > 0 && heldMinutes >= config.maxHoldMinutes) {
          exitReason = "max_hold_time";
        }
      } else if (position.tpLevel === 1) {
        if (pnlPct <= config.tp1FloorPct) exitReason = "profit_floor";
      } else if (position.tpLevel === 2) {
        if (pnlPct <= config.tp2FloorPct) exitReason = "profit_floor";
      } else {
        // Runner: ratchet the trailing stop with the peak, exit when touched.
        const ratchet = peakPnlPct - config.runnerTrailPct;
        position.runnerStopPct = Math.max(position.runnerStopPct ?? ratchet, ratchet);
        if (pnlPct <= position.runnerStopPct) exitReason = "runner_trailing_stop";
      }

      if (exitReason) {
        try {
          await this.closePosition(position, price, exitReason);
        } catch (err) {
          log.error(`Sell failed for ${position.symbol}: ${String(err)} — will retry`);
        }
      } else {
        const stopLabel =
          position.tpLevel === 0
            ? `SL -${config.stopLossPct}%`
            : position.tpLevel === 1
              ? `floor +${config.tp1FloorPct}%`
              : position.tpLevel === 2
                ? `floor +${config.tp2FloorPct}%`
                : `trail +${(position.runnerStopPct ?? 0).toFixed(0)}%`;
        log.debug(
          `${position.symbol}: $${price} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%, ` +
            `TP${position.tpLevel}, ${stopLabel}, held ${heldMinutes.toFixed(0)}min)`,
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

  /** Ladder partial sell: sells a fraction of the REMAINING bag and advances the TP level. */
  private async ladderSell(
    position: Position,
    fractionOfRemaining: number,
    newLevel: number,
    pnlPct: number,
    note: string,
  ): Promise<void> {
    const remaining = BigInt(position.remainingTokenRaw);
    const toSell = (remaining * BigInt(Math.round(fractionOfRemaining * 10_000))) / 10_000n;
    if (toSell <= 0n) {
      position.tpLevel = newLevel;
      return;
    }

    const { solReceivedLamports, signature } = await this.sellTokens(position, toSell, pnlPct);

    const costBasis =
      position.solSpentLamports * (Number(toSell) / Number(position.tokenAmountRaw));
    const pnlSol = (solReceivedLamports - costBasis) / LAMPORTS_PER_SOL;

    position.remainingTokenRaw = (remaining - toSell).toString();
    position.tpLevel = newLevel;
    position.solReceivedLamports = (position.solReceivedLamports ?? 0) + solReceivedLamports;
    if (signature) position.sellTxSignature = signature;
    this.adjustPaperBalance(solReceivedLamports);
    this.addRealizedPnl(pnlSol);
    saveState(this.state);

    const message =
      `${position.paper ? "[PAPER] " : ""}TP${newLevel} ${position.symbol} — vendu ` +
      `${Math.round(fractionOfRemaining * 100)}% du restant à +${pnlPct.toFixed(1)}% ` +
      `(+${pnlSol.toFixed(4)} SOL sécurisés) — ${note}`;
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

    this.adjustPaperBalance(solReceivedLamports);
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

  // ---- Manual control (Telegram) ----

  /**
   * Manual buy requested via Telegram. Runs the same safety and honeypot
   * checks as automatic entries; returns a human-readable result message.
   */
  async manualBuy(mint: string): Promise<string> {
    if (this.openPositions.some((p) => p.mint === mint)) {
      return "Position déjà ouverte sur ce token.";
    }
    if (this.openPositions.length >= config.maxOpenPositions) {
      return `Nombre max de positions atteint (${config.maxOpenPositions}).`;
    }
    const candidate = await getCandidateByMint(mint);
    if (!candidate) return "Token introuvable sur DexScreener (paire SOL requise).";

    const safety = await checkTokenSafety(mint).catch((err) => {
      log.warn(`Safety check errored for manual buy: ${String(err)}`);
      return null;
    });
    if (!safety) return "Échec du contrôle de sécurité (RPC), réessayez.";
    if (!safety.ok) return `Achat refusé — ${safety.reasons.join("; ")}`;

    try {
      await this.openPosition(candidate, safety.decimals);
      saveState(this.state);
      return `Achat exécuté : ${candidate.symbol} — ${config.buyAmountSol} SOL @ $${candidate.priceUsd}`;
    } catch (err) {
      return `Achat échoué : ${String(err)}`;
    }
  }

  /**
   * Manual sell requested via Telegram. `target` is a symbol, a mint, or
   * "all"; returns a human-readable result message.
   */
  async manualSell(target: string): Promise<string> {
    const open = this.openPositions;
    if (open.length === 0) return "Aucune position ouverte.";

    const matches =
      target.toLowerCase() === "all"
        ? open
        : open.filter(
            (p) =>
              p.symbol.toLowerCase() === target.toLowerCase() ||
              p.mint === target ||
              p.mint.startsWith(target),
          );
    if (matches.length === 0) return `Aucune position ne correspond à "${target}".`;

    const results: string[] = [];
    for (const position of matches) {
      const price = await getTokenPriceUsd(position.mint);
      if (price === null || price <= 0) {
        results.push(`${position.symbol}: prix indisponible, vente annulée`);
        continue;
      }
      try {
        await this.closePosition(position, price, "manual");
        results.push(`${position.symbol}: vendu (${(position.pnlPct ?? 0).toFixed(1)}%)`);
      } catch (err) {
        results.push(`${position.symbol}: échec — ${String(err)}`);
      }
    }
    return results.join("\n");
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
