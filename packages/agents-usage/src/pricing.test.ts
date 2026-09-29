import { describe, expect, it } from "vitest";
import { priceTokens, rateForModel, resolveModelRate } from "./pricing";

describe("public API pricing", () => {
  it("uses the current Codex rate and keeps cached input separate", () => {
    expect(
      priceTokens("gpt-5.3-codex", {
        input: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeCloseTo(15.925, 6);
  });

  it("uses official GPT-5.4 rates and labels internal Codex models as proxies", () => {
    expect(priceTokens("gpt-5.4", { input: 1_000_000, output: 1_000_000 })).toBe(17.5);
    expect(priceTokens("gpt-5.4-mini", { input: 1_000_000, output: 1_000_000 })).toBe(5.25);
    expect(resolveModelRate("codex-auto-review")).toMatchObject({
      kind: "proxy",
      matchedModel: "codex-auto-review",
    });
    expect(resolveModelRate("codex-unknown")).toMatchObject({
      kind: "proxy",
      matchedModel: "codex-unknown",
    });
  });

  it("uses current Claude model-specific rates before family fallbacks", () => {
    expect(
      priceTokens("claude-opus-4-8", {
        input: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeCloseTo(36.75, 6);
  });

  it("prices current GPT-6 and Claude Fable models at standard short-context rates", () => {
    expect(priceTokens("gpt-6-astra", { input: 1_000_000, output: 1_000_000 })).toBe(60);
    expect(
      priceTokens("gpt-6-sol", {
        input: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeCloseTo(14.7, 6);
    expect(priceTokens("gpt-5.6-terra", { input: 1_000_000, output: 1_000_000 })).toBe(14);
    expect(
      priceTokens("claude-fable-5-1", {
        input: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeCloseTo(72.75, 6);
    expect(
      priceTokens("claude-fable-5", {
        input: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeCloseTo(73.5, 6);
  });

  it("prices Muse and Kimi token journals with official rates where available", () => {
    expect(
      priceTokens("muse-spark-1.3", {
        input: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeCloseTo(6.9, 6);
    expect(
      priceTokens("kimi-code/k3", {
        input: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeCloseTo(21.3, 6);
    expect(resolveModelRate("kimi-code/kimi-for-coding")).toMatchObject({
      kind: "proxy",
      matchedModel: "kimi-code/kimi-for-coding",
    });
  });

  it("labels the public ChatGPT proxy used for a subscription-only revision", () => {
    expect(resolveModelRate("gpt-5.5")).toMatchObject({
      kind: "proxy",
      matchedModel: "gpt-5.5",
    });
    expect(rateForModel("gpt-5")).toBeDefined();
  });
});
