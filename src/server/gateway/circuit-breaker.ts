export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  openMs?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  openedAt?: number;
  trialInFlight: boolean;
}

/**
 * In-memory per-provider circuit breaker. After `failureThreshold` consecutive
 * failover-class failures the provider is skipped for `openMs`; then a single trial
 * request is allowed (half-open). Success closes the circuit, failure re-opens it.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.openMs = options.openMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  state(providerId: string): CircuitState {
    const entry = this.entries.get(providerId);
    if (entry?.openedAt === undefined) return "closed";
    return this.now() - entry.openedAt >= this.openMs ? "half_open" : "open";
  }

  /** Returns true when a request may be sent now. Claims the single half-open trial. */
  tryAcquire(providerId: string): boolean {
    const current = this.state(providerId);
    if (current === "closed") return true;
    if (current === "open") return false;
    const entry = this.entries.get(providerId);
    if (!entry || entry.trialInFlight) return false;
    entry.trialInFlight = true;
    return true;
  }

  recordSuccess(providerId: string): void {
    this.entries.delete(providerId);
  }

  recordFailure(providerId: string): void {
    const entry = this.entries.get(providerId) ?? { failures: 0, trialInFlight: false };
    entry.failures += 1;
    entry.trialInFlight = false;
    if (entry.openedAt !== undefined || entry.failures >= this.failureThreshold) {
      entry.openedAt = this.now();
    }
    this.entries.set(providerId, entry);
  }

  /** Releases a half-open trial claim when the attempt ended without a verdict (non-failover 4xx). */
  releaseTrial(providerId: string): void {
    const entry = this.entries.get(providerId);
    if (entry) entry.trialInFlight = false;
  }

  reset(): void {
    this.entries.clear();
  }
}

export const circuitBreaker = new CircuitBreaker();
