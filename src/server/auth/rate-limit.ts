export interface FailedLoginLimiterOptions {
  /** Failures allowed inside the window before blocking. */
  maxFailures?: number;
  /** Sliding window for counting failures (ms). */
  windowMs?: number;
  /** How long an IP stays blocked once the limit is hit (ms). */
  blockMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * In-memory per-IP limiter for failed admin logins: 10 failures within 5 minutes
 * block the IP for 5 minutes. State is per process (single-node deployment, spec section 17).
 */
export class FailedLoginLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(options: FailedLoginLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 10;
    this.windowMs = options.windowMs ?? 5 * 60_000;
    this.blockMs = options.blockMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Seconds left in the block for `ip`, or 0 when not blocked. */
  blockedForSeconds(ip: string): number {
    const until = this.blockedUntil.get(ip);
    if (until === undefined) return 0;
    const remaining = until - this.now();
    if (remaining <= 0) {
      this.blockedUntil.delete(ip);
      this.failures.delete(ip);
      return 0;
    }
    return Math.ceil(remaining / 1000);
  }

  recordFailure(ip: string): void {
    const now = this.now();
    const recent = (this.failures.get(ip) ?? []).filter((time) => now - time < this.windowMs);
    recent.push(now);
    this.failures.set(ip, recent);
    if (recent.length >= this.maxFailures) {
      this.blockedUntil.set(ip, now + this.blockMs);
    }
    this.maybePrune(now);
  }

  /** Number of addresses with retained state (diagnostics and tests). */
  get trackedIps(): number {
    return new Set([...this.failures.keys(), ...this.blockedUntil.keys()]).size;
  }

  private maybePrune(now: number): void {
    if (this.failures.size < 1000) return;
    this.prune(now);
  }

  /**
   * Removes expired blocks, then trims failure histories to the window and drops empty ones.
   * Active blocks are preserved together with their history.
   */
  prune(now: number = this.now()): void {
    for (const [ip, until] of this.blockedUntil) {
      if (until <= now) this.blockedUntil.delete(ip);
    }
    for (const [ip, times] of this.failures) {
      if (this.blockedUntil.has(ip)) continue;
      const recent = times.filter((time) => now - time < this.windowMs);
      if (recent.length === 0) this.failures.delete(ip);
      else this.failures.set(ip, recent);
    }
  }
}
