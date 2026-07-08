/**
 * Trade statistics report — run with `npm run stats`.
 * Reads the persisted state file and prints performance metrics.
 */
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadState } from "./state.js";
import type { Position } from "./types.js";

function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function sol(lamportsDelta: number): string {
  const v = lamportsDelta / LAMPORTS_PER_SOL;
  return `${v >= 0 ? "+" : ""}${v.toFixed(4)} SOL`;
}

function positionPnlLamports(p: Position): number {
  return (p.solReceivedLamports ?? 0) - p.solSpentLamports;
}

function holdMinutes(p: Position): number {
  return ((p.closedAt ?? Date.now()) - p.openedAt) / 60_000;
}

const state = loadState();
const closed = state.positions.filter((p) => p.status === "closed");
const open = state.positions.filter((p) => p.status === "open");

console.log("\n=== Meme Coin Bot — Trade Statistics ===\n");

if (closed.length === 0) {
  console.log("No closed trades yet.");
} else {
  const wins = closed.filter((p) => positionPnlLamports(p) > 0);
  const pnls = closed.map((p) => p.pnlPct ?? 0);
  const best = closed.reduce((a, b) => ((a.pnlPct ?? 0) >= (b.pnlPct ?? 0) ? a : b));
  const worst = closed.reduce((a, b) => ((a.pnlPct ?? 0) <= (b.pnlPct ?? 0) ? a : b));
  const avgPnlPct = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const avgHold = closed.reduce((s, p) => s + holdMinutes(p), 0) / closed.length;

  console.log(`Closed trades:    ${closed.length}`);
  console.log(`Win rate:         ${((wins.length / closed.length) * 100).toFixed(0)}% (${wins.length}/${closed.length})`);
  console.log(`Average PnL:      ${pct(avgPnlPct)} per trade`);
  console.log(`Average hold:     ${avgHold.toFixed(0)} min`);
  console.log(`Best trade:       ${best.symbol} ${pct(best.pnlPct ?? 0)}`);
  console.log(`Worst trade:      ${worst.symbol} ${pct(worst.pnlPct ?? 0)}`);
  console.log(`Realized PnL:     ${state.realizedPnlSol >= 0 ? "+" : ""}${state.realizedPnlSol.toFixed(4)} SOL`);
  console.log(`Today (${state.daily.date}): ${state.daily.pnlSol >= 0 ? "+" : ""}${state.daily.pnlSol.toFixed(4)} SOL`);

  console.log("\n--- By exit reason ---");
  const byReason = new Map<string, Position[]>();
  for (const p of closed) {
    const key = p.exitReason ?? "unknown";
    byReason.set(key, [...(byReason.get(key) ?? []), p]);
  }
  for (const [reason, group] of byReason) {
    const totalLamports = group.reduce((s, p) => s + positionPnlLamports(p), 0);
    console.log(`${reason.padEnd(15)} ${String(group.length).padStart(3)} trades   ${sol(totalLamports)}`);
  }

  console.log("\n--- Last 10 closed trades ---");
  const recent = [...closed]
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, 10);
  for (const p of recent) {
    const when = new Date(p.closedAt ?? 0).toISOString().replace("T", " ").slice(0, 16);
    console.log(
      `${when}  ${p.symbol.padEnd(12)} ${pct(p.pnlPct ?? 0).padStart(8)}  ` +
        `${(p.exitReason ?? "?").padEnd(13)} held ${holdMinutes(p).toFixed(0)}min${p.paper ? "  [paper]" : ""}`,
    );
  }
}

if (open.length > 0) {
  console.log("\n--- Open positions ---");
  for (const p of open) {
    const ladder = p.tpLevel === 0 ? "" : p.tpLevel === 3 ? "  (runner)" : `  (TP${p.tpLevel} done)`;
    console.log(
      `${p.symbol.padEnd(12)} entry $${p.entryPriceUsd}  held ${holdMinutes(p).toFixed(0)}min` +
        `${ladder}${p.paper ? "  [paper]" : ""}`,
    );
  }
}
console.log();
