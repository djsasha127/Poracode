import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  createUsageCostAccumulator,
  mergeCostEstimates,
  type CostEstimate,
  type UsageCostAccumulator,
  type UsageSnapshot,
} from "@poracode/agents-usage";
import type { UsageSnapshotEnricher } from "../../runtime/usageService";
import { nativeKimiHomePath } from "./paths";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface FileRef {
  path: string;
  mtimeMs: number;
  size: number;
}

interface KimiWireLine {
  type?: string;
  time?: number | string;
  model?: string;
  thinkingEffort?: string;
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
}

interface KimiUsageParserState {
  effort?: string;
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampMs(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse one Kimi wire event, retaining the effort bound earlier in that journal. */
export function addKimiUsageLine(
  accumulator: UsageCostAccumulator,
  state: KimiUsageParserState,
  rawLine: string,
): void {
  const line = rawLine.trim();
  if (!line || line[0] !== "{") return;
  let parsed: KimiWireLine;
  try {
    parsed = JSON.parse(line) as KimiWireLine;
  } catch {
    return;
  }
  if (parsed.type === "profile.bind" || parsed.type === "llm.request") {
    const effort = nonEmpty(parsed.thinkingEffort);
    if (effort) state.effort = effort;
    return;
  }
  if (parsed.type !== "usage.record" || !parsed.usage) return;
  const recordedAt = timestampMs(parsed.time);
  if (recordedAt === undefined) return;
  const input = positive(parsed.usage.inputOther);
  const output = positive(parsed.usage.output);
  const cacheRead = positive(parsed.usage.inputCacheRead);
  const cacheWrite = positive(parsed.usage.inputCacheCreation);
  if (input + output + cacheRead + cacheWrite <= 0) return;
  accumulator.add({
    timestampMs: recordedAt,
    model: nonEmpty(parsed.model) ?? "unknown",
    ...(state.effort ? { effort: state.effort } : {}),
    input,
    output,
    cacheRead,
    cacheWrite,
  });
}

async function safeReaddir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function collectWireLogs(dir: string, depth = 0): Promise<FileRef[]> {
  if (depth > 8) return [];
  const files: FileRef[] = [];
  for (const entry of await safeReaddir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectWireLogs(path, depth + 1)));
      continue;
    }
    if (!entry.isFile() || entry.name !== "wire.jsonl") continue;
    try {
      const metadata = await stat(path);
      files.push({ path, mtimeMs: metadata.mtimeMs, size: metadata.size });
    } catch {
      // Concurrently removed or unreadable journal: omit it from this refresh.
    }
  }
  return files;
}

const fileCache = new Map<
  string,
  { signature: string; windowDay: number; estimate: CostEstimate | undefined }
>();
let scanCache: { signature: string; estimate: CostEstimate | undefined } | undefined;

/** Stream retained Kimi wire journals into 30-day totals and calendar-month history. */
export async function scanKimiUsageHistory(
  nowMs: number,
  sessionsDir = join(nativeKimiHomePath(), "sessions"),
): Promise<CostEstimate | undefined> {
  const sinceMs = nowMs - THIRTY_DAYS_MS;
  const windowDay = Math.floor(sinceMs / (24 * 60 * 60 * 1000));
  const files = await collectWireLogs(sessionsDir);
  const signature = `${sessionsDir}|${windowDay}|${files
    .map((file) => `${file.path}:${file.mtimeMs}:${file.size}`)
    .sort()
    .join("|")}`;
  if (scanCache?.signature === signature) return scanCache.estimate;

  const estimates: Array<CostEstimate | undefined> = [];
  for (const file of files) {
    const fileSignature = `${file.mtimeMs}:${file.size}`;
    const cached = fileCache.get(file.path);
    if (cached?.signature === fileSignature && cached.windowDay === windowDay) {
      estimates.push(cached.estimate);
      continue;
    }
    const accumulator = createUsageCostAccumulator({ sinceMs, historySinceMs: 0, nowMs });
    const state: KimiUsageParserState = {};
    let estimate: CostEstimate | undefined;
    try {
      const lines = createInterface({
        input: createReadStream(file.path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) addKimiUsageLine(accumulator, state, line);
      estimate = accumulator.finish();
    } catch {
      // Best effort: a future refresh retries changed/unreadable journals.
    }
    fileCache.set(file.path, { signature: fileSignature, windowDay, estimate });
    estimates.push(estimate);
  }
  const estimate = mergeCostEstimates(estimates);
  scanCache = { signature, estimate };
  return estimate;
}

/** Add Kimi's provider-owned journals without replacing first-party quota data. */
export async function withKimiUsageHistory(
  snapshot: UsageSnapshot,
  nowMs: number,
): Promise<UsageSnapshot> {
  if (snapshot.providerId !== "kimi") return snapshot;
  try {
    const estimate = await scanKimiUsageHistory(nowMs);
    if (!estimate) return snapshot;
    return {
      ...snapshot,
      cost: snapshot.cost ?? estimate.cost,
      tokens: estimate.tokens,
      ...(estimate.history ? { history: estimate.history } : {}),
    };
  } catch {
    return snapshot;
  }
}

export function createKimiUsageSnapshotEnricher(): UsageSnapshotEnricher {
  return { enrich: withKimiUsageHistory };
}
