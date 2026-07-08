import { log } from "./logger.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    body: string,
  ) {
    super(`HTTP ${status} on ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

interface FetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

/**
 * Fetch JSON with timeout + exponential-backoff retries.
 * Retries on network errors, 429 and 5xx. Never retries 4xx (except 429).
 */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { method = "GET", body, timeoutMs = 10_000, retries = 3, headers = {} } = opts;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: body ? { "content-type": "application/json", ...headers } : headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new HttpError(res.status, url, text);
        if (res.status === 429 || res.status >= 500) {
          lastError = err;
          throw err; // retryable, handled below
        }
        throw err; // non-retryable — rethrown past the catch via marker
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      const retryable =
        !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
      if (!retryable || attempt === retries) throw err;
      const delay = Math.min(500 * 2 ** attempt, 8_000) + Math.random() * 250;
      log.debug(`Retrying ${url} in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
