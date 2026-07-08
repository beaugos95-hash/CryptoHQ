/**
 * Deterministic test of the TP ladder and daily circuit breakers.
 * Uses the live price of BONK (very liquid) and crafts entry prices so the
 * position PnL is exactly the scenario we want. Paper mode only.
 * Run: STATE_FILE=state/ladder-test.json node test-ladder.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const STATE = process.env.STATE_FILE ?? "state/ladder-test.json";
let failures = 0;

function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!condition) failures++;
}

function makePosition(price, pnlPct, extra = {}) {
  const entry = price / (1 + pnlPct / 100);
  return {
    id: "test-" + Math.random().toString(36).slice(2),
    mint: BONK,
    symbol: "BONK",
    status: "open",
    solSpentLamports: 100_000_000, // 0.1 SOL
    tokenAmountRaw: "1000000000",
    remainingTokenRaw: "1000000000",
    tpLevel: 0,
    tokenDecimals: 5,
    entryPriceUsd: entry,
    peakPriceUsd: price,
    openedAt: Date.now(),
    paper: true,
    ...extra,
  };
}

function writeState(positions, daily = {}) {
  mkdirSync("state", { recursive: true });
  writeFileSync(
    STATE,
    JSON.stringify({
      positions,
      cooldowns: {},
      realizedPnlSol: 0,
      daily: { date: new Date().toISOString().slice(0, 10), pnlSol: 0, startBalanceSol: 1, peakProfitPct: 0, ...daily },
      paperBalanceLamports: 1_000_000_000,
      tradingEnabled: true,
    }),
  );
}

const { getTokenPriceUsd } = await import("./dist/discovery.js");
const price = await getTokenPriceUsd(BONK);
if (!price) throw new Error("Cannot fetch BONK price");
console.log(`BONK price: $${price}\n`);

async function freshTrader() {
  // Trader reads the state file at construction; cache-bust the module is not
  // needed since state is re-read per instance.
  const { Trader } = await import("./dist/trader.js");
  return new Trader();
}

// --- Scenario 1: +20% -> TP1 sells 50%, level 1 ---
writeState([makePosition(price, 20)]);
let trader = await freshTrader();
await trader.monitorPositions();
let p = trader.state.positions[0];
check("TP1 triggers at +20%", p.tpLevel === 1, `tpLevel=${p.tpLevel}`);
check("TP1 sold half", p.remainingTokenRaw === "500000000", `remaining=${p.remainingTokenRaw}`);
check("TP1 position still open", p.status === "open");

// --- Scenario 2: level 1, PnL falls to +5% (< +10% floor) -> full exit ---
writeState([makePosition(price, 5, { tpLevel: 1, remainingTokenRaw: "500000000" })]);
trader = await freshTrader();
await trader.monitorPositions();
p = trader.state.positions[0];
check("Floor TP1: closes at +5%", p.status === "closed", `status=${p.status}`);
check("Floor TP1: reason profit_floor", p.exitReason === "profit_floor", `reason=${p.exitReason}`);

// --- Scenario 3: level 1, +40% -> TP2 sells half of remaining ---
writeState([makePosition(price, 40, { tpLevel: 1, remainingTokenRaw: "500000000" })]);
trader = await freshTrader();
await trader.monitorPositions();
p = trader.state.positions[0];
check("TP2 triggers at +40%", p.tpLevel === 2, `tpLevel=${p.tpLevel}`);
check("TP2 sold half of remaining", p.remainingTokenRaw === "250000000", `remaining=${p.remainingTokenRaw}`);

// --- Scenario 4: level 2, +80% -> TP3 keeps 10% runner, sets trail ---
writeState([makePosition(price, 80, { tpLevel: 2, remainingTokenRaw: "250000000" })]);
trader = await freshTrader();
await trader.monitorPositions();
p = trader.state.positions[0];
check("TP3 triggers at +80%", p.tpLevel === 3, `tpLevel=${p.tpLevel}`);
check("TP3 keeps 10% runner", p.remainingTokenRaw === "25000000", `remaining=${p.remainingTokenRaw}`);
check(
  "Runner stop = pnl - 20 (≈ +60%)",
  Math.abs(p.runnerStopPct - 60) < 0.5,
  `runnerStopPct=${p.runnerStopPct?.toFixed(1)}`,
);

// --- Scenario 5: runner with peak +135% and current +80% -> ratchet to +115 and exit ---
const runnerPos = makePosition(price, 80, { tpLevel: 3, remainingTokenRaw: "25000000", runnerStopPct: 60 });
runnerPos.peakPriceUsd = runnerPos.entryPriceUsd * 2.35; // peak = +135%
writeState([runnerPos]);
trader = await freshTrader();
await trader.monitorPositions();
p = trader.state.positions[0];
check("Runner ratchet: stop moved to +115%", Math.abs(p.runnerStopPct - 115) < 0.5, `stop=${p.runnerStopPct?.toFixed(1)}`);
check("Runner exits below trail", p.status === "closed", `status=${p.status}`);
check("Runner exit reason", p.exitReason === "runner_trailing_stop", `reason=${p.exitReason}`);

// --- Scenario 6: base SL at -15% -> stop_loss ---
writeState([makePosition(price, -15)]);
trader = await freshTrader();
await trader.monitorPositions();
p = trader.state.positions[0];
check("Base SL -12%: closes at -15%", p.status === "closed" && p.exitReason === "stop_loss", `reason=${p.exitReason}`);

// --- Scenario 7: daily loss cap -30% of day-start balance ---
writeState([], { pnlSol: -0.30, startBalanceSol: 1 });
trader = await freshTrader();
check("Daily loss cap hit at -30%", trader["isDailyStopHit"]() === true);

// --- Scenario 8: daily profit lock — peak +45%, now +38% (< +40 floor) ---
writeState([], { pnlSol: 0.38, startBalanceSol: 1, peakProfitPct: 45 });
trader = await freshTrader();
check("Profit lock: peak 45, now 38 -> paused", trader["isDailyStopHit"]() === true);

// --- Scenario 9: daily profit — peak +45%, now +42% (>= +40 floor) -> keeps trading ---
writeState([], { pnlSol: 0.42, startBalanceSol: 1, peakProfitPct: 45 });
trader = await freshTrader();
check("Profit lock: peak 45, now 42 -> continues", trader["isDailyStopHit"]() === false);

// --- Scenario 10: daily profit below activation (+20% < +25%) -> keeps trading ---
writeState([], { pnlSol: 0.20, startBalanceSol: 1, peakProfitPct: 20 });
trader = await freshTrader();
check("Profit lock inactive below +25%", trader["isDailyStopHit"]() === false);

rmSync(STATE, { force: true });
console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
