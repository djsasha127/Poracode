import { describe, expect, it } from "vitest";
import {
  aggregateClaudeCost,
  aggregateCodexCost,
  aggregateCodexCostLines,
  mergeCostEstimates,
} from "./cost";

const NOW = Date.parse("2026-05-29T00:00:00Z");
const SINCE = NOW - 30 * 86_400_000;
const TS = "2026-05-28T12:00:00Z";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("aggregateClaudeCost", () => {
  it("sums tokens per model, dedups by message:request, prices at list rates", () => {
    const a = line({
      type: "assistant",
      requestId: "r1",
      timestamp: TS,
      message: {
        id: "m1",
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 500 },
      },
    });
    const dup = a; // same message:request → ignored
    const b = line({
      type: "assistant",
      requestId: "r2",
      timestamp: TS,
      message: { id: "m2", model: "claude-opus-4-8", usage: { input_tokens: 1_000_000 } },
    });
    const noise = line({ type: "user", message: {} });

    const est = aggregateClaudeCost([`${a}\n${dup}\n${b}\n${noise}`], {
      sinceMs: SINCE,
      nowMs: NOW,
    });
    expect(est).toBeDefined();
    expect(est?.tokens.input).toBe(1_001_000);
    expect(est?.tokens.output).toBe(2000);
    expect(est?.tokens.cacheRead).toBe(500);
    expect(est?.tokens.total).toBe(1_003_500);
    // Opus 4.8 input 1M * $5/1M = $5, the largest contributor.
    expect(est?.topModel).toBe("claude-opus-4-8");
    expect(est?.cost.estimated).toBe(true);
    expect(est?.cost.currency).toBe("USD");
    expect(est?.cost.amount).toBeGreaterThan(5);
  });

  it("excludes entries outside the window and returns undefined when empty", () => {
    const old = line({
      type: "assistant",
      requestId: "r",
      timestamp: "2020-01-01T00:00:00Z",
      message: { id: "m", model: "claude-sonnet", usage: { input_tokens: 100 } },
    });
    expect(aggregateClaudeCost([old], { sinceMs: SINCE, nowMs: NOW })).toBeUndefined();
    expect(aggregateClaudeCost([""], { sinceMs: 0, nowMs: NOW })).toBeUndefined();
    expect(
      aggregateClaudeCost(
        [
          line({
            type: "assistant",
            requestId: "synthetic",
            timestamp: TS,
            message: {
              id: "synthetic",
              model: "<synthetic>",
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
        ],
        { sinceMs: 0, historySinceMs: 0, nowMs: NOW },
      ),
    ).toBeUndefined();
  });

  it("retains older calendar months with model, effort, and reasoning tokens", () => {
    const oldTimestamp = "2026-03-10T12:00:00Z";
    const estimate = aggregateClaudeCost(
      [
        line({
          type: "assistant",
          requestId: "history-request",
          timestamp: oldTimestamp,
          effort: "high",
          message: {
            id: "history-message",
            model: "claude-sonnet-4-5",
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              output_tokens_details: { thinking_tokens: 8 },
            },
          },
        }),
      ],
      { sinceMs: SINCE, historySinceMs: 0, nowMs: NOW },
    );

    expect(estimate?.tokens.total).toBe(0);
    expect(estimate?.history?.months).toEqual([
      expect.objectContaining({
        month: "2026-03",
        reasoningTokens: 8,
        models: [
          expect.objectContaining({
            model: "claude-sonnet-4-5",
            effort: "high",
            reasoningTokens: 8,
          }),
        ],
      }),
    ]);
  });
});

describe("aggregateCodexCost", () => {
  it("uses per-turn usage, separates cached input, and dedups replayed responses", () => {
    const context = line({
      timestamp: TS,
      type: "turn_context",
      payload: { model: "gpt-5.3-codex" },
    });
    const usage = line({
      timestamp: TS,
      type: "token_usage_record",
      payload: {
        response_id: "resp-1",
        turn_token_usage: {
          input_tokens: 1_100_000,
          cached_input_tokens: 100_000,
          cache_write_input_tokens: 0,
          output_tokens: 100_000,
          total_tokens: 1_200_000,
        },
      },
    });

    const estimate = aggregateCodexCost([`${context}\n${usage}\n${usage}`], {
      sinceMs: SINCE,
      nowMs: NOW,
    });

    expect(estimate?.tokens).toMatchObject({
      total: 1_200_000,
      input: 1_000_000,
      cacheRead: 100_000,
      output: 100_000,
    });
    expect(estimate?.cost.amount).toBeCloseTo(3.1675, 6);
    expect(estimate?.topModel).toBe("gpt-5.3-codex");
  });

  it("groups Codex history by model and effort and records reasoning output", () => {
    const estimate = aggregateCodexCost(
      [
        [
          line({
            timestamp: TS,
            type: "turn_context",
            payload: { model: "gpt-5.3-codex", effort: "xhigh" },
          }),
          line({
            timestamp: TS,
            type: "token_usage_record",
            payload: {
              response_id: "reasoning-response",
              usage: {
                input_tokens: 100,
                output_tokens: 30,
                reasoning_output_tokens: 12,
              },
            },
          }),
        ].join("\n"),
      ],
      { sinceMs: SINCE, historySinceMs: 0, nowMs: NOW },
    );

    expect(estimate?.history?.months[0]?.models[0]).toMatchObject({
      model: "gpt-5.3-codex",
      effort: "xhigh",
      reasoningTokens: 12,
    });
  });

  it("recovers legacy token_count months without doubling the native-record overlap", () => {
    const estimate = aggregateCodexCost(
      [
        [
          line({
            timestamp: "2026-08-10T12:00:00Z",
            type: "event_msg",
            payload: {
              type: "thread_settings_applied",
              thread_settings: { model: "gpt-5.6-sol", reasoning_effort: "low" },
            },
          }),
          line({
            timestamp: "2026-08-10T12:01:00Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: {
                  input_tokens: 1_100,
                  cached_input_tokens: 100,
                  output_tokens: 200,
                  reasoning_output_tokens: 50,
                },
              },
            },
          }),
          line({
            timestamp: "2026-09-04T12:00:00Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: { last_token_usage: { input_tokens: 400, output_tokens: 40 } },
            },
          }),
          line({
            timestamp: "2026-09-04T12:00:00Z",
            type: "token_usage_record",
            payload: {
              response_id: "native-september",
              usage: { input_tokens: 400, output_tokens: 40 },
            },
          }),
        ].join("\n"),
      ],
      {
        sinceMs: Date.parse("2026-09-01T00:00:00Z"),
        historySinceMs: 0,
        nowMs: Date.parse("2026-09-29T00:00:00Z"),
      },
    );

    expect(estimate?.tokens.total).toBe(440);
    expect(estimate?.history?.months.map((month) => month.month)).toEqual(["2026-09", "2026-08"]);
    expect(estimate?.history?.months[1]).toMatchObject({
      tokens: { total: 1_300, input: 1_000, cacheRead: 100, output: 200 },
      reasoningTokens: 50,
      models: [expect.objectContaining({ model: "gpt-5.6-sol", effort: "low" })],
    });
  });

  it("applies the first model context to replayed legacy counters that precede it", () => {
    const estimate = aggregateCodexCost(
      [
        [
          line({
            timestamp: TS,
            type: "event_msg",
            payload: {
              type: "token_count",
              info: { last_token_usage: { input_tokens: 100, output_tokens: 20 } },
            },
          }),
          line({
            timestamp: TS,
            type: "turn_context",
            payload: { model: "gpt-5.3-codex", effort: "high" },
          }),
        ].join("\n"),
      ],
      { sinceMs: SINCE, historySinceMs: 0, nowMs: NOW },
    );

    expect(estimate?.history?.months[0]?.models).toEqual([
      expect.objectContaining({ model: "gpt-5.3-codex", effort: "high" }),
    ]);
    expect(estimate?.tokens.priced).toBe(120);
  });

  it("prefers the per-response delta over the cumulative turn counter", () => {
    const estimate = aggregateCodexCost(
      [
        [
          line({ type: "turn_context", payload: { model: "gpt-5.3-codex" } }),
          line({
            timestamp: TS,
            type: "token_usage_record",
            payload: {
              response_id: "resp-delta",
              usage: { input_tokens: 100, output_tokens: 10 },
              turn_token_usage: { input_tokens: 10_000, output_tokens: 1_000 },
            },
          }),
        ].join("\n"),
      ],
      { sinceMs: SINCE, nowMs: NOW },
    );
    expect(estimate?.tokens.total).toBe(110);
  });

  it("tracks tokens but leaves cost at zero when the model has no public rate", () => {
    const estimate = aggregateCodexCost(
      [
        [
          line({ type: "turn_context", payload: { model: "codex-private" } }),
          line({
            timestamp: TS,
            type: "token_usage_record",
            payload: { response_id: "resp-x", usage: { input_tokens: 100, output_tokens: 10 } },
          }),
        ].join("\n"),
      ],
      { sinceMs: SINCE, nowMs: NOW },
    );
    expect(estimate?.tokens.total).toBe(110);
    expect(estimate?.cost.amount).toBe(0);
    expect(estimate?.tokens.priced).toBe(0);
  });

  it("prices gpt-5.5 with the labeled public ChatGPT proxy rate", () => {
    const estimate = aggregateCodexCost(
      [
        [
          line({ type: "turn_context", payload: { model: "gpt-5.5" } }),
          line({
            timestamp: TS,
            type: "token_usage_record",
            payload: {
              response_id: "resp-proxy",
              usage: {
                input_tokens: 1_100_000,
                cached_input_tokens: 100_000,
                output_tokens: 100_000,
              },
            },
          }),
        ].join("\n"),
      ],
      { sinceMs: SINCE, nowMs: NOW },
    );

    expect(estimate?.cost.amount).toBe(8.05);
    expect(estimate?.tokens.priced).toBe(1_200_000);
    expect(estimate?.tokens.proxyPriced).toBe(1_200_000);
  });

  it("streams separate files and merges their complete totals", async () => {
    async function* linesFor(model: string, responseId: string, input: number) {
      yield line({ type: "turn_context", payload: { model } });
      yield line({
        timestamp: TS,
        type: "token_usage_record",
        payload: { response_id: responseId, usage: { input_tokens: input } },
      });
    }

    const first = await aggregateCodexCostLines(linesFor("gpt-5.3-codex", "r1", 100), {
      sinceMs: SINCE,
      nowMs: NOW,
    });
    const second = await aggregateCodexCostLines(linesFor("gpt-5.5", "r2", 200), {
      sinceMs: SINCE,
      nowMs: NOW,
    });
    const merged = mergeCostEstimates([first, second]);

    expect(merged?.tokens.total).toBe(300);
    expect(merged?.tokens.priced).toBe(300);
    expect(merged?.tokens.proxyPriced).toBe(200);
    expect(merged?.history?.months[0]?.tokens.total).toBe(300);
  });
});
