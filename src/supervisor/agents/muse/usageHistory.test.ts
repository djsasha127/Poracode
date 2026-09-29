import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanMuseUsageHistory, withMuseUsageHistory } from "./usageHistory";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const tempDirs: string[] = [];

function tempSessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "poracode-muse-usage-"));
  tempDirs.push(dir);
  return dir;
}

function modelCompleted(timestampMs: number, model: string): string {
  return JSON.stringify({
    payload_type: "runtime.session",
    recorded_at: timestampMs * 1_000,
    payload: {
      kind: "run",
      event: {
        kind: "model_completed",
        model,
        usage: {
          input_tokens: 1_100,
          cached_tokens: 100,
          cache_read_tokens: 100,
          cache_write_tokens: 0,
          output_tokens: 80,
          reasoning_tokens: 30,
        },
      },
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Muse usage history", () => {
  it("streams retained journals and applies the public Muse API-rate equivalent", async () => {
    const sessionsDir = tempSessionsDir();
    const nested = join(sessionsDir, "2026", "09", "session");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "session.jsonl"),
      `${modelCompleted(NOW - 60_000, "muse-spark-1.3")}\n${modelCompleted(
        NOW - 40 * 86_400_000,
        "muse-spark-1.2",
      )}\n`,
    );

    const estimate = await scanMuseUsageHistory(NOW, sessionsDir);

    expect(estimate?.tokens).toMatchObject({ total: 1_180, input: 1_000, cacheRead: 100 });
    expect(estimate?.tokens.priced).toBe(1_180);
    expect(estimate?.cost.amount).toBeCloseTo(0.001605, 6);
    expect(estimate?.history?.months).toHaveLength(2);
    expect(estimate?.history?.months[0]?.models[0]).toMatchObject({
      model: "muse-spark-1.3",
      reasoningTokens: 30,
    });
    expect(estimate?.history?.months[0]?.models[0]?.effort).toBeUndefined();
  });

  it("only enriches the Muse snapshot and preserves its billed cost", async () => {
    const other = {
      providerId: "neutral",
      status: "ok" as const,
      windows: [],
      fetchedAt: NOW,
    };
    expect(await withMuseUsageHistory(other, NOW)).toBe(other);
  });
});
