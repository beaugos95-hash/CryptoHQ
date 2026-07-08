import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config, validateConfig } from "./config.js";
import { getSolRates } from "./fx.js";
import { sleep } from "./http.js";
import { log } from "./logger.js";
import { TelegramControl } from "./telegram.js";
import { Trader } from "./trader.js";
import { checkWalletBalance } from "./wallet.js";

let shuttingDown = false;

async function main(): Promise<void> {
  validateConfig();

  log.info("Meme coin trading bot starting", {
    mode: config.dryRun ? "PAPER (dry-run)" : "LIVE",
    buyAmountSol: config.buyAmountSol,
    maxOpenPositions: config.maxOpenPositions,
    ladder: `SL -${config.stopLossPct}% | TP1 +${config.tp1Pct}% (floor +${config.tp1FloorPct}%) | TP2 +${config.tp2Pct}% (floor +${config.tp2FloorPct}%) | TP3 +${config.tp3Pct}% (runner ${config.runnerKeepFraction * 100}%, trail ${config.runnerTrailPct}pts)`,
    daily: `loss cap -${config.maxDailyLossPct}%, profit lock +${config.dailyProfitLockPct}% (tiers ${config.dailyProfitTierPct}pts)`,
  });
  if (!config.dryRun) {
    log.warn("LIVE MODE: real funds will be traded. Ctrl+C now if this is unintended.");
    await sleep(5_000);
  }
  await checkWalletBalance();

  const trader = new Trader();
  await trader.init();

  const telegram = new TelegramControl(trader);
  telegram.start();

  const balanceSol = trader.paperBalanceLamports / LAMPORTS_PER_SOL;
  let balanceLine = "";
  if (config.dryRun) {
    const { eurPerSol } = await getSolRates();
    balanceLine = `\nBalance papier : ${balanceSol.toFixed(4)} SOL (${(balanceSol * eurPerSol).toFixed(2)}€)`;
  }
  await telegram.send(
    `🤖 Bot démarré en mode ${config.dryRun ? "PAPER (simulation)" : "LIVE"}${balanceLine}\n` +
      `Trading auto : ${trader.tradingEnabled ? "▶️ actif" : "⏸ en pause — envoyez /startbot pour démarrer"}\n` +
      `Tapez /help pour les commandes.`,
  );
  if (!trader.tradingEnabled) {
    log.info("Trading paused at startup (AUTOSTART=false) — waiting for /startbot on Telegram");
  }

  const onSignal = (signal: string) => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info(`${signal} received, shutting down after current iteration…`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let lastScan = 0;
  while (!shuttingDown) {
    const now = Date.now();
    try {
      // Monitoring runs on every tick (fast exits protect capital);
      // discovery runs on its own slower cadence.
      await trader.monitorPositions();
      if (now - lastScan >= config.scanIntervalSec * 1_000) {
        lastScan = now;
        await trader.scanAndBuy();
      }
    } catch (err) {
      log.error(`Main loop iteration failed: ${String(err)}`);
    }
    await sleep(config.monitorIntervalSec * 1_000);
  }

  telegram.stop();
  await telegram.send("🔌 Bot arrêté.");
  trader.printSummary();
}

main().catch((err) => {
  log.error(`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
