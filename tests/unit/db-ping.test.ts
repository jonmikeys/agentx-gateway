import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { pingConnection } from "@/server/db/client";

/** A stand-in for `sql\`...\`` whose `.signal()` handler controls the outcome. */
function sqlReturning(modifier: (signal: AbortSignal) => Promise<unknown>): postgres.Sql {
  const query = { signal: modifier };
  return (() => query) as unknown as postgres.Sql;
}

describe("pingConnection", () => {
  it("resolves true when the query answers", async () => {
    const sql = sqlReturning(async () => [{ "?column?": 1 }]);
    await expect(pingConnection(sql, 50)).resolves.toBe(true);
  });

  it("resolves false and cancels the query when the deadline passes", async () => {
    let observed: AbortSignal | undefined;
    const sql = sqlReturning(
      (signal) =>
        new Promise((_, reject) => {
          observed = signal;
          signal.addEventListener("abort", () => reject(new Error("query timeout")), {
            once: true,
          });
        }),
    );

    await expect(pingConnection(sql, 5)).resolves.toBe(false);
    expect(observed?.aborted).toBe(true);
  });
});
