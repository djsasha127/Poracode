import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanKimiUsageHistory, withKimiUsageHistory } from "./usageHistory";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const tempDirs: string[] = [];

function tempSessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "poracode-kimi-usage-"));
  tempDirs.push(dir);
  return dir;
}

function wireLine(value: unknown): string {
  return JSON.stringify(value);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Kimi usage history", () => {
  it("streams wire journals with model, effort, and current API-rate equivalents", async () => {
    const sessionsDir = tempSessionsDir();
    const agentDir = join(sessionsDir, "workspace", "session", "agents", "main");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "wire.jsonl"),
      [
        wireLine({ type: "profile.bind", time: NOW - 61_000, thinkingEffort: "high" }),
        wireLine({
          type: "usage.record",
          time: NOW - 60_000,
          model: "kimi-code/k3",
          usage: {
            inputOther: 1_000,
            output: 100,
            inputCacheRead: 200,
            inputCacheCreation: 50,
          },
        }),
        wireLine({
          type: "usage.record",
          time: NOW - 40 * 86_400_000,
          model: "kimi-code/kimi-for-coding",
          usage: { inputOther: 500, output: 50, inputCacheRead: 0, inputCacheCreation: 0 },
        }),
      ].join("\n"),
    );

    const estimate = await scanKimiUsageHistory(NOW, sessionsDir);

    expect(estimate?.tokens).toMatchObject({
      total: 1_350,
      input: 1_000,
      output: 100,
      cacheRead: 200,
      cacheWrite: 50,
      priced: 1_350,
      proxyPriced: 0,
    });
    expect(estimate?.cost.amount).toBeCloseTo(0.00471, 6);
    expect(estimate?.history?.months).toHaveLength(2);
    expect(estimate?.history?.months[0]?.models[0]).toMatchObject({
      model: "kimi-code/k3",
      effort: "high",
    });
    expect(estimate?.history?.months[1]?.models[0]?.tokens.proxyPriced).toBe(550);
  });

  it("does not alter another provider's snapshot", async () => {
    const other = {
      providerId: "neutral",
      status: "ok" as const,
      windows: [],
      fetchedAt: NOW,
    };
    expect(await withKimiUsageHistory(other, NOW)).toBe(other);
  });
});
