import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
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

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface FileRef {
  path: string;
  mtimeMs: number;
  size: number;
}

interface MuseModelCompletedEvent {
  kind?: string;
  model?: string;
  effort?: string;
  reasoning_effort?: string;
  usage?: Record<string, unknown>;
}

interface MuseSessionLine {
  payload_type?: string;
  recorded_at?: number | string;
  payload?: {
    kind?: string;
    event?: MuseModelCompletedEvent;
  };
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordedAtMs(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Muse journals currently use microseconds; tolerate ordinary epoch ms too.
    return value > 10_000_000_000_000 ? value / 1_000 : value;
  }
  if (typeof value !== "string") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return recordedAtMs(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse one provider-owned journal event into the shared history accumulator. */
export function addMuseUsageLine(accumulator: UsageCostAccumulator, rawLine: string): void {
  const line = rawLine.trim();
  if (!line || line[0] !== "{") return;
  let parsed: MuseSessionLine;
  try {
    parsed = JSON.parse(line) as MuseSessionLine;
  } catch {
    return;
  }
  const event = parsed.payload?.event;
  if (
    parsed.payload_type !== "runtime.session" ||
    parsed.payload?.kind !== "run" ||
    event?.kind !== "model_completed" ||
    !event.usage
  ) {
    return;
  }
  const timestampMs = recordedAtMs(parsed.recorded_at);
  if (timestampMs === undefined) return;
  const rawInput = positive(event.usage.input_tokens ?? event.usage.inputTokens);
  const cacheRead = positive(
    event.usage.cached_input_tokens ??
      event.usage.cache_read_input_tokens ??
      event.usage.cacheReadInputTokens ??
      event.usage.cache_read_tokens ??
      event.usage.cached_tokens,
  );
  const cacheWrite = positive(
    event.usage.cache_creation_input_tokens ??
      event.usage.cache_write_input_tokens ??
      event.usage.cacheWriteInputTokens ??
      event.usage.cache_write_tokens,
  );
  const output = positive(event.usage.output_tokens ?? event.usage.outputTokens);
  const reasoningTokens = positive(
    event.usage.reasoning_tokens ??
      event.usage.reasoning_output_tokens ??
      event.usage.reasoningTokens,
  );
  if (rawInput + output + cacheRead + cacheWrite <= 0) return;
  const effort = nonEmpty(event.reasoning_effort ?? event.effort);
  accumulator.add({
    timestampMs,
    model: nonEmpty(event.model) ?? "unknown",
    ...(effort ? { effort } : {}),
    input: Math.max(0, rawInput - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  });
}

async function safeReaddir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function collectSessionLogs(dir: string, depth = 0): Promise<FileRef[]> {
  if (depth > 8) return [];
  const files: FileRef[] = [];
  for (const entry of await safeReaddir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSessionLogs(path, depth + 1)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
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

/** Stream Muse journals into 30-day totals plus all retained calendar months. */
export async function scanMuseUsageHistory(
  nowMs: number,
  sessionsDir = join(homedir(), ".local", "share", "muse", "sessions"),
): Promise<CostEstimate | undefined> {
  const sinceMs = nowMs - THIRTY_DAYS_MS;
  const windowDay = Math.floor(sinceMs / (24 * 60 * 60 * 1000));
  const files = await collectSessionLogs(sessionsDir);
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
    let estimate: CostEstimate | undefined;
    try {
      const lines = createInterface({
        input: createReadStream(file.path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) addMuseUsageLine(accumulator, line);
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

/** Provider-owned hook that adds local history and a current public API-rate equivalent. */
export async function withMuseUsageHistory(
  snapshot: UsageSnapshot,
  nowMs: number,
): Promise<UsageSnapshot> {
  if (snapshot.providerId !== "muse") return snapshot;
  try {
    const estimate = await scanMuseUsageHistory(nowMs);
    if (!estimate) return snapshot;
    return {
      ...snapshot,
      // A first-party billed amount, when Muse exposes one, remains authoritative.
      cost: snapshot.cost ?? estimate.cost,
      tokens: estimate.tokens,
      ...(estimate.history ? { history: estimate.history } : {}),
    };
  } catch {
    return snapshot;
  }
}

export function createMuseUsageSnapshotEnricher(): UsageSnapshotEnricher {
  return { enrich: withMuseUsageHistory };
}
