import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { BotState } from "./types.js";

const statePath = resolve(config.stateFile);

export function loadState(): BotState {
  try {
    const raw = readFileSync(statePath, "utf8");
    const state = JSON.parse(raw) as BotState;
    if (!Array.isArray(state.positions)) throw new Error("corrupt state: positions");
    log.info(
      `State loaded: ${state.positions.filter((p) => p.status === "open").length} open positions, ` +
        `realized PnL ${state.realizedPnlSol.toFixed(4)} SOL`,
    );
    return state;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`Could not load state file, starting fresh: ${String(err)}`);
    }
    return { positions: [], cooldowns: {}, realizedPnlSol: 0 };
  }
}

/** Atomic write (tmp file + rename) so a crash can never corrupt the state. */
export function saveState(state: BotState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath);
}
