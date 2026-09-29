import { describe, expect, it } from "vitest";
import type { ProfileTokenProvider, ProfileTokenStats } from "@/shared/contracts";
import { hasScannedTokenHistory, selectRecordedUsage } from "./recordedUsageSource";

function provider(providerId: string, tokens: number): ProfileTokenProvider {
  return { provider: providerId, label: providerId, tokens, percent: 100 };
}

function stats(entries: ProfileTokenProvider[], reviewedAt: string): ProfileTokenStats {
  return {
    available: entries.length > 0,
    scope: "device",
    device: { id: reviewedAt, label: reviewedAt, platform: "darwin" },
    generatedAt: 1,
    timezoneOffsetMinutes: 0,
    windowDays: 30,
    lifetimeTokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
    breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costBreakdownUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    pricedTokens: 0,
    unpricedTokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
    pricingReviewedAt: reviewedAt,
    peakDayTokens: 0,
    providers: entries,
    accounts: [],
    models: [],
    tokenHeatmap: { metric: "tokens", windowDays: 30, cells: [], max: 0 },
    unavailableProviders: [],
  };
}

describe("selectRecordedUsage", () => {
  it("prefers remote token history even when quota selection may be local", () => {
    const local = stats([provider("codex", 10)], "local");
    const remote = stats([provider("codex", 250)], "remote");

    expect(selectRecordedUsage("codex", local, remote, true)).toMatchObject({
      source: "remote",
      usage: { tokens: 250 },
      stats: { pricingReviewedAt: "remote" },
    });
  });

  it("falls back to local history when the remote host has no matching provider", () => {
    const local = stats([provider("codex", 10)], "local");
    const remote = stats([provider("claude", 250)], "remote");

    expect(selectRecordedUsage("codex", local, remote, true)).toMatchObject({
      source: "local",
      usage: { tokens: 10 },
    });
  });

  it("uses only local history outside a remote workspace", () => {
    const local = stats([provider("codex", 10)], "local");
    const remote = stats([provider("codex", 250)], "remote");

    expect(selectRecordedUsage("codex", local, remote, false)).toMatchObject({
      source: "local",
      usage: { tokens: 10 },
    });
  });
});

describe("hasScannedTokenHistory", () => {
  it("prefers a priced 30-day transcript scan over the legacy activity ledger", () => {
    expect(
      hasScannedTokenHistory({
        providerId: "codex",
        status: "ok",
        windows: [],
        fetchedAt: 1,
        cost: { currency: "USD", amount: 2046, period: "30d", estimated: true },
        tokens: { total: 7_793_000_000, period: "30d" },
      }),
    ).toBe(true);
  });

  it("does not hide the activity ledger for quota snapshots without a scan", () => {
    expect(
      hasScannedTokenHistory({
        providerId: "muse",
        status: "ok",
        windows: [],
        fetchedAt: 1,
      }),
    ).toBe(false);
  });
});
