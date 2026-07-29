/**
 * DECKSHOT rooms — sliding-window rate limiter.
 *
 * Owner: lobby-ui-hud.
 *
 * Someone will point a script at the lobby endpoints. Limits are keyed by
 * remote address (a script cycling sockets still shares an address) and
 * driven entirely by the registry's clock, so tests control time exactly.
 */

interface Rule {
  limit: number;
  windowMs: number;
}

export const CREATE_RULE: Rule = { limit: 4, windowMs: 10_000 };
export const JOIN_RULE: Rule = { limit: 10, windowMs: 10_000 };
export const CHAT_RULE: Rule = { limit: 6, windowMs: 5_000 };

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly rule: Rule) {}

  /**
   * Record an attempt at `now` (ms) and report whether it is allowed.
   * Attempts over the limit are NOT recorded, so a spammer's clock does not
   * keep extending their own lockout window.
   */
  allow(key: string, now: number): boolean {
    const cutoff = now - this.rule.windowMs;
    let times = this.hits.get(key);
    if (!times) {
      times = [];
      this.hits.set(key, times);
    }
    // Drop entries older than the window (list is ascending).
    let stale = 0;
    while (stale < times.length && times[stale] <= cutoff) stale++;
    if (stale > 0) times.splice(0, stale);

    if (times.length >= this.rule.limit) return false;
    times.push(now);
    return true;
  }

  /** Forget keys with no recent activity. Called from the registry tick. */
  prune(now: number): void {
    const cutoff = now - this.rule.windowMs;
    for (const [key, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1] <= cutoff) {
        this.hits.delete(key);
      }
    }
  }
}
