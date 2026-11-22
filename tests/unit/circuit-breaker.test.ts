import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "@/server/gateway/circuit-breaker";

describe("CircuitBreaker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => new CircuitBreaker({ now: () => Date.now() });
  const fail = (breaker: CircuitBreaker, id: string, times: number) => {
    for (let index = 0; index < times; index += 1) breaker.recordFailure(id);
  };

  it("stays closed below the failure threshold", () => {
    const breaker = make();
    fail(breaker, "p", 2);
    expect(breaker.state("p")).toBe("closed");
    expect(breaker.tryAcquire("p")).toBe(true);
  });

  it("opens after 3 consecutive failures and blocks for 30 s", () => {
    const breaker = make();
    fail(breaker, "p", 3);
    expect(breaker.state("p")).toBe("open");
    expect(breaker.tryAcquire("p")).toBe(false);
    vi.advanceTimersByTime(29_999);
    expect(breaker.state("p")).toBe("open");
  });

  it("a success resets the consecutive count", () => {
    const breaker = make();
    fail(breaker, "p", 2);
    breaker.recordSuccess("p");
    fail(breaker, "p", 1);
    expect(breaker.state("p")).toBe("closed");
  });

  it("goes half-open after 30 s and allows exactly one trial", () => {
    const breaker = make();
    fail(breaker, "p", 3);
    vi.advanceTimersByTime(30_000);
    expect(breaker.state("p")).toBe("half_open");
    expect(breaker.tryAcquire("p")).toBe(true);
    expect(breaker.tryAcquire("p")).toBe(false);
  });

  it("closes on a successful trial", () => {
    const breaker = make();
    fail(breaker, "p", 3);
    vi.advanceTimersByTime(30_000);
    breaker.tryAcquire("p");
    breaker.recordSuccess("p");
    expect(breaker.state("p")).toBe("closed");
    expect(breaker.tryAcquire("p")).toBe(true);
  });

  it("re-opens for another 30 s on a failed trial", () => {
    const breaker = make();
    fail(breaker, "p", 3);
    vi.advanceTimersByTime(30_000);
    breaker.tryAcquire("p");
    breaker.recordFailure("p");
    expect(breaker.state("p")).toBe("open");
    vi.advanceTimersByTime(30_000);
    expect(breaker.state("p")).toBe("half_open");
  });

  it("releases an unused trial", () => {
    const breaker = make();
    fail(breaker, "p", 3);
    vi.advanceTimersByTime(30_000);
    breaker.tryAcquire("p");
    breaker.releaseTrial("p");
    expect(breaker.tryAcquire("p")).toBe(true);
  });

  it("tracks providers independently", () => {
    const breaker = make();
    fail(breaker, "a", 3);
    expect(breaker.state("b")).toBe("closed");
  });
});
