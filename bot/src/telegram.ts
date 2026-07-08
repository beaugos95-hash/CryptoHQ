/**
 * Full remote control of the bot over Telegram (long polling).
 * Only the chat configured in TELEGRAM_CHAT_ID may issue commands.
 */
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config, TUNABLE_KEYS, type TunableKey } from "./config.js";
import { getSolRates } from "./fx.js";
import { log } from "./logger.js";
import { getTokenPriceUsd } from "./discovery.js";
import type { Trader } from "./trader.js";
import { twitterEnabled } from "./twitter.js";

interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

interface TgUpdatesResponse {
  ok: boolean;
  result: TgUpdate[];
}

const HELP = `🤖 *Commandes disponibles*

*Contrôle*
/startbot — activer le trading automatique
/stopbot — mettre le trading en pause (positions toujours surveillées)
/buy \`<mint>\` — achat manuel (mêmes contrôles de sécurité)
/sell \`<symbole|mint|all>\` — vente manuelle
/panic — tout vendre ET mettre en pause

*Suivi*
/status — mode, balance, PnL, positions
/positions — détail des positions ouvertes
/stats — statistiques de trading
/settings — paramètres actuels

*Réglages*
/set \`<param> <valeur>\` — modifier un paramètre à chaud
Exemple : \`/set buyAmountSol 0.1\`

/help — ce message`;

export class TelegramControl {
  private offset = 0;
  private running = false;

  constructor(private readonly trader: Trader) {}

  get enabled(): boolean {
    return config.telegramBotToken !== "" && config.telegramChatId !== "";
  }

  private api(method: string): string {
    return `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
  }

  async send(text: string, markdown = false): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(this.api("sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text,
          ...(markdown ? { parse_mode: "Markdown" } : {}),
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.warn(`Telegram send failed: HTTP ${res.status}`);
    } catch (err) {
      log.warn(`Telegram send failed: ${String(err)}`);
    }
  }

  /** Starts the long-polling loop. Runs until stop() is called. */
  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    void this.pollLoop();
    log.info("Telegram remote control active");
  }

  stop(): void {
    this.running = false;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const res = await fetch(
          `${this.api("getUpdates")}?timeout=25&offset=${this.offset}&allowed_updates=["message"]`,
          { signal: AbortSignal.timeout(35_000) },
        );
        if (!res.ok) {
          log.warn(`Telegram getUpdates failed: HTTP ${res.status}`);
          await new Promise((r) => setTimeout(r, 5_000));
          continue;
        }
        const body = (await res.json()) as TgUpdatesResponse;
        for (const update of body.result) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (this.running) {
          log.debug(`Telegram poll error: ${String(err)}`);
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text) return;
    // Security: ignore anyone who is not the configured owner chat.
    if (String(message.chat.id) !== config.telegramChatId) {
      log.warn(`Ignored Telegram message from unauthorized chat ${message.chat.id}`);
      return;
    }
    try {
      await this.handleCommand(message.text.trim());
    } catch (err) {
      log.error(`Telegram command failed: ${String(err)}`);
      await this.send(`Erreur : ${String(err)}`);
    }
  }

  private async handleCommand(text: string): Promise<void> {
    const [rawCommand = "", ...args] = text.split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/@\w+$/, "");

    switch (command) {
      case "/start":
      case "/help":
        return this.send(HELP, true);
      case "/startbot":
        this.trader.setTradingEnabled(true);
        return this.send("▶️ Trading automatique ACTIVÉ.");
      case "/stopbot":
        this.trader.setTradingEnabled(false);
        return this.send("⏸ Trading automatique EN PAUSE. Les positions ouvertes restent surveillées.");
      case "/status":
        return this.send(await this.statusText());
      case "/positions":
        return this.send(await this.positionsText());
      case "/stats":
        return this.send(this.statsText());
      case "/settings":
        return this.send(this.settingsText(), true);
      case "/set":
        return this.send(this.setParam(args));
      case "/buy": {
        const mint = args[0];
        if (!mint) return this.send("Usage : /buy <adresse du mint>");
        await this.send(`Achat de ${mint.slice(0, 8)}… en cours (contrôles de sécurité)…`);
        return this.send(await this.trader.manualBuy(mint));
      }
      case "/sell": {
        const target = args[0];
        if (!target) return this.send("Usage : /sell <symbole|mint|all>");
        return this.send(await this.trader.manualSell(target));
      }
      case "/panic": {
        this.trader.setTradingEnabled(false);
        const result = await this.trader.manualSell("all");
        return this.send(`🛑 PANIC : trading en pause.\n${result}`);
      }
      default:
        return this.send(`Commande inconnue : ${command}\nTapez /help`);
    }
  }

  private async statusText(): Promise<string> {
    const { eurPerSol } = await getSolRates();
    const open = this.trader.openPositions;
    const state = this.trader.state;

    const lines = [
      `Mode : ${config.dryRun ? "📄 PAPER (simulation)" : "🔴 LIVE (fonds réels)"}`,
      `Trading auto : ${this.trader.tradingEnabled ? "▶️ actif" : "⏸ en pause"}`,
    ];
    if (config.dryRun) {
      const balanceSol = this.trader.paperBalanceLamports / LAMPORTS_PER_SOL;
      lines.push(
        `Balance papier : ${balanceSol.toFixed(4)} SOL (${(balanceSol * eurPerSol).toFixed(2)}€)`,
      );
    }
    const pnlEur = state.realizedPnlSol * eurPerSol;
    lines.push(
      `PnL réalisé : ${state.realizedPnlSol >= 0 ? "+" : ""}${state.realizedPnlSol.toFixed(4)} SOL (${pnlEur >= 0 ? "+" : ""}${pnlEur.toFixed(2)}€)`,
      `PnL du jour : ${state.daily.pnlSol >= 0 ? "+" : ""}${state.daily.pnlSol.toFixed(4)} SOL`,
      `Positions : ${open.length}/${config.maxOpenPositions}`,
      `Sources : DexScreener ✅, Birdeye ${config.birdeyeApiKey ? "✅" : "—"}, ` +
        `Twitter ${twitterEnabled() ? "✅" : "—"}, GMGN ${config.gmgnEnabled ? "(best effort)" : "—"}`,
    );
    return lines.join("\n");
  }

  private async positionsText(): Promise<string> {
    const open = this.trader.openPositions;
    if (open.length === 0) return "Aucune position ouverte.";
    const lines: string[] = [];
    for (const p of open) {
      const price = await getTokenPriceUsd(p.mint);
      const pnl =
        price !== null && price > 0
          ? `${(((price - p.entryPriceUsd) / p.entryPriceUsd) * 100).toFixed(1)}%`
          : "?";
      const held = Math.round((Date.now() - p.openedAt) / 60_000);
      const ladder =
        p.tpLevel === 0
          ? ""
          : p.tpLevel === 3
            ? ` — runner (trail +${(p.runnerStopPct ?? 0).toFixed(0)}%)`
            : ` — TP${p.tpLevel} ✅`;
      lines.push(
        `${p.symbol} — PnL ${pnl.startsWith("-") ? "🔻" : "🟢"} ${pnl} — ${held}min${ladder}` +
          `\n  entrée $${p.entryPriceUsd} → $${price ?? "?"}`,
      );
    }
    return lines.join("\n");
  }

  private statsText(): string {
    const closed = this.trader.state.positions.filter((p) => p.status === "closed");
    if (closed.length === 0) return "Aucun trade clôturé pour l'instant.";
    const wins = closed.filter((p) => (p.pnlPct ?? 0) > 0).length;
    const avg = closed.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / closed.length;
    const byReason = new Map<string, number>();
    for (const p of closed) {
      byReason.set(p.exitReason ?? "?", (byReason.get(p.exitReason ?? "?") ?? 0) + 1);
    }
    return [
      `Trades clôturés : ${closed.length}`,
      `Win rate : ${((wins / closed.length) * 100).toFixed(0)}% (${wins}/${closed.length})`,
      `PnL moyen : ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}%/trade`,
      `Sorties : ${[...byReason].map(([r, n]) => `${r} ×${n}`).join(", ")}`,
    ].join("\n");
  }

  private settingsText(): string {
    const lines = TUNABLE_KEYS.map((key) => `\`${key}\` = ${config[key]}`);
    return `*Paramètres modifiables* (via /set)\n${lines.join("\n")}`;
  }

  private setParam(args: string[]): string {
    const [key, value] = args;
    if (!key || value === undefined) return "Usage : /set <param> <valeur>\nVoir /settings";
    const match = TUNABLE_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
    if (!match) return `Paramètre inconnu : ${key}\nVoir /settings pour la liste.`;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return `Valeur invalide : ${value}`;

    const before = config[match];
    (config as Record<TunableKey, number>)[match] = parsed;
    log.info(`Setting changed via Telegram: ${match} ${before} -> ${parsed}`);
    return `✅ ${match} : ${before} → ${parsed}`;
  }
}
