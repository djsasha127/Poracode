import { describe, expect, it } from "vitest";
import { usageHistorySessionSummarySchema } from "./usage";

describe("usageHistorySessionSummarySchema", () => {
  it("accepts filesystem timestamps with fractional milliseconds", () => {
    const parsed = usageHistorySessionSummarySchema.parse({
      sessionId: "session-1",
      sourceId: "archive-1",
      machine: "server.local",
      fileSize: 42,
      modifiedAt: 1_786_162_650_378.3313,
      fingerprint: "fingerprint",
      tokens: {
        total: 1,
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        priced: 1,
        proxyPriced: 0,
      },
      estimatedCostUsd: 0,
    });

    expect(parsed.modifiedAt).toBe(1_786_162_650_378.3313);
  });
});
