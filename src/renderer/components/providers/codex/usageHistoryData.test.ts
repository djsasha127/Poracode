import { describe, expect, it } from "vitest";
import type { UsageHistorySessionSummary } from "@/shared/contracts";
import { aggregateUsageHistorySessions, mergeUsageHistorySessions } from "./usageHistoryData";

function session(
  id: string,
  sourceId: string,
  fileSize: number,
  input: number,
): UsageHistorySessionSummary {
  return {
    sessionId: id,
    sourceId,
    machine: sourceId,
    fileSize,
    modifiedAt: 1,
    fingerprint: `${sourceId}-${fileSize}`,
    tokens: { total: input, input, output: 0, cacheRead: 0, cacheWrite: 0 },
    estimatedCostUsd: input / 1_000_000,
    history: {
      months: [
        {
          month: "2026-09",
          tokens: { total: input, input, output: 0, cacheRead: 0, cacheWrite: 0 },
          estimatedCostUsd: input / 1_000_000,
          models: [
            {
              model: "gpt-5",
              effort: "high",
              tokens: { total: input, input, output: 0, cacheRead: 0, cacheWrite: 0 },
              estimatedCostUsd: input / 1_000_000,
            },
          ],
        },
      ],
    },
  };
}

describe("Codex cross-machine usage history", () => {
  it("counts one copy of the same rollout and prefers the more complete file", () => {
    const local = [session("same", "local", 100, 100), session("local-only", "local", 80, 80)];
    const remote = [session("same", "remote", 200, 200), session("remote-only", "remote", 90, 90)];
    const merged = mergeUsageHistorySessions([local, remote]);
    expect(merged).toHaveLength(3);
    expect(merged.find((entry) => entry.sessionId === "same")?.sourceId).toBe("remote");
    expect(aggregateUsageHistorySessions(merged)?.tokens.total).toBe(370);
    expect(aggregateUsageHistorySessions(merged)?.history?.months[0]?.models[0]).toMatchObject({
      model: "gpt-5",
      effort: "high",
      tokens: { total: 370 },
    });
  });
});
