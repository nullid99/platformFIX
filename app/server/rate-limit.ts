/**
 * In-memory fixed-window request counter (security review STG-5, 2026-10-17: the API had no rate
 * limits at all). The API runs as a single process, so memory is enough — the counters reset on a
 * restart, which only ever loosens a limit for a minute.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private lastPrunedAt = 0;

  /** Counts one hit for `key`; false once it is over `limit` within the current `windowMs`. */
  public hit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    this.prune(windowMs, now);
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  // Drops finished windows now and then, so one-off keys (an IP that came once) don't pile up.
  private prune(windowMs: number, now: number): void {
    if (now - this.lastPrunedAt < 60_000) return;
    this.lastPrunedAt = now;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= windowMs) this.windows.delete(key);
    }
  }
}

export type RateLimitRule = {
  /** Short name — part of the counter key and of the log line when the limit is hit. */
  name: string;
  method: string;
  path: RegExp;
  limit: number;
  windowMs: number;
};

const TEN_MINUTES = 10 * 60_000;

/**
 * Generous on purpose — far above what a person does by hand (a ДЗ is at most 5 files, a busy
 * student asks a few questions a day); they only stop scripts and floods. Counted per signed-in
 * session, or per IP when there is none.
 */
export const API_RATE_LIMIT_RULES: RateLimitRule[] = [
  { name: "auth", method: "GET", path: /^\/api\/auth\/(discord\/start|discord\/callback|verify-email)$/, limit: 30, windowMs: TEN_MINUTES },
  { name: "file-create", method: "POST", path: /^\/api\/files$/, limit: 60, windowMs: TEN_MINUTES },
  { name: "file-upload", method: "PUT", path: /^\/api\/files\/[^/]+\/content$/, limit: 60, windowMs: TEN_MINUTES },
  { name: "discussion-create", method: "POST", path: /^\/api\/discussions$/, limit: 20, windowMs: TEN_MINUTES },
  { name: "discussion-reply", method: "POST", path: /^\/api\/discussions\/[^/]+\/messages$/, limit: 60, windowMs: TEN_MINUTES },
  { name: "submission", method: "POST", path: /^\/api\/assignments\/[^/]+\/submissions$/, limit: 30, windowMs: TEN_MINUTES },
];

export function findRateLimitRule(method: string, path: string): RateLimitRule | undefined {
  return API_RATE_LIMIT_RULES.find((rule) => rule.method === method && rule.path.test(path));
}

/** Stream chat (Socket.IO "chat:send"): 20 messages per 30 s per person. */
export const CHAT_SEND_LIMIT = { limit: 20, windowMs: 30_000 };
