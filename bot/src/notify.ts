import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Optional Telegram notifications (buy/sell/alerts).
 * Fire-and-forget: a notification failure must never disturb trading,
 * so errors are logged and swallowed.
 */
export function notify(text: string): void {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(8_000),
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.warn(`Telegram notification failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
    })
    .catch((err) => log.warn(`Telegram notification failed: ${String(err)}`));
}
