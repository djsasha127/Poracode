import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_USAGE_HISTORY_INDEX_VERSION,
  CODEX_USAGE_HISTORY_PARSER_VERSION,
  CodexUsageHistoryIndex,
  codexSessionIdFromPath,
} from "./usageHistoryIndex";
import type { UsageHistorySourceSetting } from "@/shared/settings";
import { PRICING_TABLE_REVISION } from "@poracode/agents-usage";

const NOW = Date.UTC(2026, 8, 29, 12);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "poracode-usage-history-"));
  roots.push(root);
  return root;
}

function rolloutName(date: string, id: string): string {
  return `rollout-${date}-${id}.jsonl`;
}

function rollout(options: {
  id: string;
  timestamp: string;
  model?: string;
  effort?: string;
  input?: number;
  output?: number;
  padding?: number;
}): string {
  const model = options.model ?? "gpt-5.5";
  const effort = options.effort ?? "medium";
  const input = options.input ?? 100;
  const output = options.output ?? 20;
  return [
    JSON.stringify({
      timestamp: options.timestamp,
      type: "session_meta",
      payload: { id: options.id },
    }),
    JSON.stringify({
      timestamp: options.timestamp,
      type: "turn_context",
      payload: { model, effort },
    }),
    JSON.stringify({
      timestamp: options.timestamp,
      type: "token_usage_record",
      payload: {
        response_id: `${options.id}-response`,
        usage: {
          input_tokens: input,
          cached_input_tokens: Math.floor(input / 4),
          output_tokens: output,
          reasoning_output_tokens: Math.floor(output / 2),
        },
      },
    }),
    options.padding ? JSON.stringify({ padding: "x".repeat(options.padding) }) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function writeRollout(
  root: string,
  folder: "sessions" | "archived_sessions" | "direct",
  date: string,
  id: string,
  content: string,
): Promise<string> {
  const dir = folder === "direct" ? root : join(root, folder, date.slice(0, 4), date.slice(5, 7));
  await mkdir(dir, { recursive: true });
  const path = join(dir, rolloutName(`${date}T10-00-00`, id));
  await writeFile(path, content, "utf8");
  return path;
}

describe("CodexUsageHistoryIndex", () => {
  it("extracts the final rollout UUID without depending on a username or mount path", () => {
    expect(
      codexSessionIdFromPath(
        "/any/machine/archive/rollout-2026-05-22T10-00-00-11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222.jsonl",
      ),
    ).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("indexes sessions, archived_sessions, and multiple roots with deterministic dedup", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const ext = join(root, "external-a");
    const backup = join(root, "external-b");
    const indexPath = join(root, "state", "history.json");
    const sharedId = "11111111-1111-4111-8111-111111111111";
    const archivedId = "22222222-2222-4222-8222-222222222222";
    const externalId = "33333333-3333-4333-8333-333333333333";

    await writeRollout(
      home,
      "sessions",
      "2026-05-22",
      sharedId,
      rollout({ id: sharedId, timestamp: "2026-05-22T10:00:00Z", input: 100 }),
    );
    await writeRollout(
      home,
      "archived_sessions",
      "2026-06-03",
      archivedId,
      rollout({
        id: archivedId,
        timestamp: "2026-06-03T10:00:00Z",
        model: "gpt-5.3-codex",
        effort: "high",
      }),
    );
    await writeRollout(
      ext,
      "direct",
      "2026-05-22",
      sharedId,
      rollout({
        id: sharedId,
        timestamp: "2026-05-22T10:00:00Z",
        input: 400,
        padding: 200,
      }),
    );
    await writeRollout(
      ext,
      "direct",
      "2026-09-01",
      externalId,
      rollout({
        id: externalId,
        timestamp: "2026-09-01T10:00:00Z",
        effort: "xhigh",
      }),
    );
    await writeRollout(
      backup,
      "direct",
      "2026-05-22",
      sharedId,
      `${rollout({
        id: sharedId,
        timestamp: "2026-05-22T10:00:00Z",
        input: 900,
        padding: 500,
      })}\nBROKEN MID-FILE\n${JSON.stringify({ tail: "still-json" })}`,
    );

    const additional: UsageHistorySourceSetting[] = [
      { id: "ext", name: "EXT", path: ext, enabled: true },
      { id: "backup", name: "Backup", path: backup, enabled: true },
    ];
    const parsed: string[] = [];
    const index = new CodexUsageHistoryIndex({
      indexPath,
      codexHome: home,
      machine: "test-mac",
      now: () => NOW,
      readAdditionalSources: () => additional,
      onParseFile: (path) => parsed.push(path),
    });

    const first = await index.refresh({ providerId: "codex" });
    expect(first.indexVersion).toBe(CODEX_USAGE_HISTORY_INDEX_VERSION);
    expect(first.uniqueSessions).toBe(3);
    expect(first.candidateFiles).toBe(5);
    expect(first.earliestSessionAt).toBe(Date.UTC(2026, 4, 22, 10));
    expect(first.sources.map((source) => source.id)).toEqual([
      "default-sessions",
      "default-archived-sessions",
      "ext",
      "backup",
    ]);
    expect(first.sources.find((source) => source.id === "ext")?.uniqueSessions).toBe(2);
    expect(parsed).toHaveLength(5);

    const page = await index.getPage({ providerId: "codex", limit: 20 });
    expect(page.sessions).toHaveLength(3);
    const selectedShared = page.sessions.find((session) => session.sessionId === sharedId);
    expect(selectedShared?.sourceId).toBe("ext");
    expect(selectedShared?.tokens.total).toBeGreaterThan(400);
    expect(selectedShared?.history?.months[0]?.models[0]?.effort).toBe("medium");
    expect(
      page.sessions.find((session) => session.sessionId === archivedId)?.history?.months[0],
    ).toMatchObject({
      month: "2026-06",
      models: [expect.objectContaining({ model: "gpt-5.3-codex", effort: "high" })],
    });

    const second = await index.refresh({ providerId: "codex" });
    expect(second.digest).toBe(first.digest);
    expect(index.getCachedAggregate()?.tokens.total).toBe(
      page.sessions.reduce((total, session) => total + (session.tokens.total ?? 0), 0),
    );
  });

  it("keeps an offline archive cached and skips unchanged contents after restart", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const ext = join(root, "external");
    const offline = join(root, "external-offline");
    const indexPath = join(root, "state", "history.json");
    const localId = "44444444-4444-4444-8444-444444444444";
    const extId = "55555555-5555-4555-8555-555555555555";
    await writeRollout(
      home,
      "sessions",
      "2026-08-01",
      localId,
      rollout({ id: localId, timestamp: "2026-08-01T10:00:00Z" }),
    );
    await writeRollout(
      ext,
      "direct",
      "2026-09-01",
      extId,
      rollout({ id: extId, timestamp: "2026-09-01T10:00:00Z" }),
    );
    const additional: UsageHistorySourceSetting[] = [
      { id: "ext", name: "EXT", path: ext, enabled: true },
    ];
    const first = new CodexUsageHistoryIndex({
      indexPath,
      codexHome: home,
      machine: "test-mac",
      now: () => NOW,
      readAdditionalSources: () => additional,
    });
    const before = await first.refresh({ providerId: "codex" });
    expect(before.uniqueSessions).toBe(2);

    let reparsed = 0;
    const restarted = new CodexUsageHistoryIndex({
      indexPath,
      codexHome: home,
      machine: "test-mac",
      now: () => NOW + 1_000,
      readAdditionalSources: () => additional,
      onParseFile: () => {
        reparsed += 1;
      },
    });
    const unchanged = await restarted.refresh({ providerId: "codex" });
    expect(unchanged.digest).toBe(before.digest);
    expect(reparsed).toBe(0);

    await rename(ext, offline);
    const disconnected = await restarted.refresh({ providerId: "codex", sourceId: "ext" });
    expect(disconnected.uniqueSessions).toBe(2);
    expect(disconnected.sources.find((source) => source.id === "ext")?.status).toBe("offline");
    expect((await restarted.getPage({ providerId: "codex" })).sessions).toHaveLength(2);
  });

  it("reprices persisted summaries without reparsing unchanged rollout files", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const indexPath = join(root, "state", "history.json");
    const id = "77777777-7777-4777-8777-777777777777";
    await writeRollout(
      home,
      "sessions",
      "2026-09-02",
      id,
      rollout({ id, timestamp: "2026-09-02T10:00:00Z", model: "gpt-5.4" }),
    );
    const first = new CodexUsageHistoryIndex({
      indexPath,
      codexHome: home,
      machine: "test-mac",
      now: () => NOW,
      readAdditionalSources: () => [],
    });
    await first.refresh({ providerId: "codex" });

    const persisted = JSON.parse(await readFile(indexPath, "utf8")) as {
      pricingRevision?: string;
      files: Record<
        string,
        {
          estimate?: {
            cost: { amount: number };
            history?: { months: Array<{ estimatedCostUsd: number }> };
          };
        }
      >;
    };
    persisted.pricingRevision = "stale-pricing";
    const cachedFile = Object.values(persisted.files)[0];
    if (!cachedFile?.estimate) throw new Error("Expected a cached estimate");
    cachedFile.estimate.cost.amount = 0;
    for (const month of cachedFile.estimate.history?.months ?? []) month.estimatedCostUsd = 0;
    await writeFile(indexPath, JSON.stringify(persisted), "utf8");

    let reparsed = 0;
    const restarted = new CodexUsageHistoryIndex({
      indexPath,
      codexHome: home,
      machine: "test-mac",
      now: () => NOW + 1_000,
      readAdditionalSources: () => [],
      onParseFile: () => {
        reparsed += 1;
      },
    });
    await restarted.refresh({ providerId: "codex" });
    expect(reparsed).toBe(0);
    expect(
      (await restarted.getPage({ providerId: "codex" })).sessions[0]?.estimatedCostUsd,
    ).toBeCloseTo(0.00049375, 8);
    expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({
      pricingRevision: PRICING_TABLE_REVISION,
    });
  });

  it("reparses unchanged files only when the parser revision changes", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const indexPath = join(root, "state", "history.json");
    const id = "88888888-8888-4888-8888-888888888888";
    await writeRollout(
      home,
      "sessions",
      "2026-09-03",
      id,
      rollout({ id, timestamp: "2026-09-03T10:00:00Z" }),
    );
    const first = new CodexUsageHistoryIndex({
      indexPath,
      codexHome: home,
      machine: "test-mac",
      now: () => NOW,
      readAdditionalSources: () => [],
    });
    await first.refresh({ providerId: "codex" });

    const persisted = JSON.parse(await readFile(indexPath, "utf8")) as {
      files: Record<string, { parserVersion?: number }>;
    };
    const cachedFile = Object.values(persisted.files)[0];
    if (!cachedFile) throw new Error("Expected an indexed rollout");
    cachedFile.parserVersion = CODEX_USAGE_HISTORY_PARSER_VERSION - 1;
    await writeFile(indexPath, JSON.stringify(persisted), "utf8");

    let reparsed = 0;
    const restarted = new CodexUsageHistoryIndex({
      indexPath,
      codexHome: home,
      machine: "test-mac",
      now: () => NOW + 1_000,
      readAdditionalSources: () => [],
      onParseFile: () => {
        reparsed += 1;
      },
    });
    await restarted.refresh({ providerId: "codex" });
    expect(reparsed).toBe(1);
    const reparsedIndex = JSON.parse(await readFile(indexPath, "utf8")) as {
      files: Record<string, { parserVersion?: number }>;
    };
    expect(Object.values(reparsedIndex.files)[0]?.parserVersion).toBe(
      CODEX_USAGE_HISTORY_PARSER_VERSION,
    );
  });

  it("invalidates an incompatible persisted index without reading its stale summaries", async () => {
    const root = await tempRoot();
    const indexPath = join(root, "state", "history.json");
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(
      indexPath,
      JSON.stringify({
        version: 0,
        providerId: "codex",
        machine: "old",
        sources: {},
        files: {
          stale: {
            sessionId: "66666666-6666-4666-8666-666666666666",
            valid: true,
          },
        },
      }),
      "utf8",
    );
    const index = new CodexUsageHistoryIndex({
      indexPath,
      codexHome: join(root, "empty-home"),
      machine: "new",
      now: () => NOW,
      readAdditionalSources: () => [],
    });
    const digest = await index.refresh({ providerId: "codex" });
    expect(digest.uniqueSessions).toBe(0);
    expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({
      version: CODEX_USAGE_HISTORY_INDEX_VERSION,
      machine: "new",
      files: {},
    });
  });
});
