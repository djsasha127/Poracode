import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate from the real `~/.claude/projects` (this machine has live logs there)
// by pointing homedir at a temp dir; only the fixture below is read.
const osMock = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osMock.home };
});

const { scanClaudeCost, scanCodexCost } = await import("./usageCostScanner");

const NOW = Date.now();

function writeSessionLog(home: string): void {
  const dir = join(home, ".claude", "projects", "proj1");
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    timestamp: new Date(NOW - 60_000).toISOString(),
    requestId: "req-1",
    effort: "high",
    message: {
      id: "msg-1",
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  });
  const historical = JSON.stringify({
    type: "assistant",
    timestamp: new Date(NOW - 45 * 86_400_000).toISOString(),
    requestId: "req-old",
    perTurnEffort: "medium",
    message: {
      id: "msg-old",
      model: "claude-opus-4-8",
      usage: { input_tokens: 40, output_tokens: 10 },
    },
  });
  writeFileSync(join(dir, "session.jsonl"), `${historical}\n${line}\n`);
}

function writeCodexSessionLog(home: string): void {
  const dir = join(home, ".codex", "sessions", "2026", "09", "29");
  mkdirSync(dir, { recursive: true });
  const context = JSON.stringify({
    timestamp: new Date(NOW - 61_000).toISOString(),
    type: "turn_context",
    payload: { model: "gpt-5.3-codex", effort: "xhigh" },
  });
  const usage = JSON.stringify({
    timestamp: new Date(NOW - 60_000).toISOString(),
    type: "token_usage_record",
    payload: {
      response_id: "resp-codex-1",
      turn_token_usage: {
        input_tokens: 1_100,
        cached_input_tokens: 100,
        output_tokens: 50,
        reasoning_output_tokens: 25,
      },
    },
  });
  writeFileSync(join(dir, "rollout.jsonl"), `${context}\n${usage}\n`);
}

let savedConfigDir: string | undefined;

beforeEach(() => {
  osMock.home = mkdtempSync(join(tmpdir(), "lc-cost-"));
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  rmSync(osMock.home, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

describe("scanClaudeCost", () => {
  it("estimates 30-day tokens/cost from recent Claude session logs", async () => {
    writeSessionLog(osMock.home);
    const scan = await scanClaudeCost(NOW);
    expect(scan.estimate).toBeDefined();
    expect(scan.estimate?.tokens.total).toBe(150);
    expect(scan.estimate?.cost.estimated).toBe(true);
    expect(scan.estimate?.history?.months.length).toBeGreaterThanOrEqual(2);
    expect(
      scan.estimate?.history?.months.flatMap((month) => month.models).map((model) => model.effort),
    ).toEqual(expect.arrayContaining(["high", "medium"]));
    expect(scan.truncated).toBe(false);
  });

  it("memoizes on an unchanged log tree (same result object)", async () => {
    writeSessionLog(osMock.home);
    const first = await scanClaudeCost(NOW);
    const second = await scanClaudeCost(NOW);
    expect(second).toBe(first);
  });

  it("returns no estimate when there are no logs", async () => {
    const scan = await scanClaudeCost(NOW);
    expect(scan.estimate).toBeUndefined();
  });
});

describe("scanCodexCost", () => {
  it("recursively estimates 30-day tokens/cost from Codex rollout logs", async () => {
    writeCodexSessionLog(osMock.home);
    const scan = await scanCodexCost(NOW);
    expect(scan.estimate?.tokens).toMatchObject({ total: 1_150, input: 1_000, cacheRead: 100 });
    expect(scan.estimate?.cost.amount).toBeGreaterThan(0);
    expect(scan.estimate?.history?.months[0]?.models[0]).toMatchObject({
      effort: "xhigh",
      reasoningTokens: 25,
    });
    expect(scan.truncated).toBe(false);
  });

  it("memoizes an unchanged Codex session tree", async () => {
    writeCodexSessionLog(osMock.home);
    const first = await scanCodexCost(NOW);
    const second = await scanCodexCost(NOW);
    expect(second).toBe(first);
  });
});
