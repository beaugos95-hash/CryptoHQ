/**
 * Minimal, zero-dependency structured logger.
 * Writes a single line per event so logs stay parseable and fast.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
const minLevel = LEVELS[envLevel] ?? LEVELS.info;

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function write(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString();
  const extra = data ? " " + JSON.stringify(data) : "";
  const line = `${COLORS[level]}${ts} [${level.toUpperCase().padEnd(5)}]${RESET} ${msg}${extra}`;
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => write("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
};
