import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import {
  PRICING_TABLE_REVISION,
  PRICING_TABLE_REVIEWED,
  aggregateCodexCostLines,
  mergeCostEstimates,
  priceTokens,
  resolveModelRate,
  type CostEstimate,
  type UsageHistory,
  type UsageHistoryModel,
  type UsageHistoryMonth,
  type UsageTokens,
} from "@poracode/agents-usage";
import type {
  RefreshUsageHistoryPayload,
  UsageHistoryAggregate,
  UsageHistoryDigest,
  UsageHistoryPagePayload,
  UsageHistoryPageResponse,
  UsageHistorySessionSummary,
  UsageHistorySourceDigest,
  UsageHistorySourceKind,
  UsageHistorySourceStatus,
} from "@/shared/contracts";
import type { SharedSettings, UsageHistorySourceSetting } from "@/shared/settings";
import type { UsageHistoryProvider } from "../../runtime/usageHistoryProvider";

/** Increment when persisted metadata or selection semantics become incompatible. */
export const CODEX_USAGE_HISTORY_INDEX_VERSION = 1;
/** Increment when unchanged rollout files must be parsed again for correctness. */
export const CODEX_USAGE_HISTORY_PARSER_VERSION = 3;
const PROVIDER_ID = "codex";
const DEFAULT_PAGE_SIZE = 200;
const CHECKPOINT_FILE_INTERVAL = 100;
const CHECKPOINT_TIME_INTERVAL_MS = 30_000;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

interface FileRef {
  path: string;
  size: number;
  mtimeMs: number;
}

interface ConfiguredSource {
  id: string;
  name: string;
  path: string;
  kind: UsageHistorySourceKind;
  enabled: boolean;
}

interface PersistedSource extends ConfiguredSource {
  machine: string;
  status: UsageHistorySourceStatus;
  lastIndexedAt?: number;
  processedFiles?: number;
  totalFiles?: number;
}

interface IndexedFile {
  sourceId: string;
  path: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
  parserVersion?: number;
  fingerprint: string;
  valid: boolean;
  startedAt?: number;
  estimate?: CostEstimate;
}

interface PersistedIndex {
  version: number;
  providerId: string;
  machine: string;
  pricingReviewedAt: string;
  pricingRevision?: string;
  sources: Record<string, PersistedSource>;
  files: Record<string, IndexedFile>;
  savedAt: number;
}

export interface CodexUsageHistoryIndexOptions {
  indexPath: string;
  readAdditionalSources(): readonly UsageHistorySourceSetting[];
  codexHome?: string;
  machine?: string;
  now?: () => number;
  /** Test/diagnostic observer; called only when file contents are actually parsed. */
  onParseFile?: (path: string) => void;
}

export function createCodexUsageHistoryProvider(options: {
  cacheDir: string;
  readSettings(): SharedSettings;
}): CodexUsageHistoryIndex {
  return new CodexUsageHistoryIndex({
    indexPath: join(options.cacheDir, "codex-usage-history-index.json"),
    readAdditionalSources: () => options.readSettings().usage.historySources[PROVIDER_ID] ?? [],
  });
}

function emptyIndex(machine: string): PersistedIndex {
  return {
    version: CODEX_USAGE_HISTORY_INDEX_VERSION,
    providerId: PROVIDER_ID,
    machine,
    pricingReviewedAt: PRICING_TABLE_REVIEWED,
    pricingRevision: PRICING_TABLE_REVISION,
    sources: {},
    files: {},
    savedAt: 0,
  };
}

function resolveHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveDefaultCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? resolveHomePath(configured) : join(userHome, ".codex");
}

export function codexSessionIdFromPath(path: string): string | undefined {
  if (!basename(path).startsWith("rollout-") || !path.endsWith(".jsonl")) return undefined;
  const matches = basename(path).match(UUID_PATTERN);
  return matches?.at(-1)?.toLowerCase();
}

function startedAtFromPath(path: string): number | undefined {
  const match = basename(path).match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const value = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isFinite(value) ? value : undefined;
}

function sourceFileKey(sourceId: string, path: string): string {
  return `${sourceId}\u0000${normalize(path)}`;
}

async function safeReaddir(path: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function collectRolloutFiles(root: string): Promise<FileRef[] | undefined> {
  if (!(await isDirectory(root))) return undefined;
  const files: FileRef[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) continue;
    const entries = await safeReaddir(dir);
    if (!entries) {
      // Treat an unreadable root like a disconnected archive so a transient
      // mount/permission failure cannot erase its last known derived index.
      if (dir === root) return undefined;
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !codexSessionIdFromPath(path)) continue;
      try {
        const fileStat = await stat(path);
        files.push({ path, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
      } catch {
        // Concurrently moved files are retried on the next refresh.
      }
    }
  }
  return files;
}

async function parseRollout(file: FileRef, nowMs: number): Promise<IndexedFile> {
  const sessionId = codexSessionIdFromPath(file.path);
  if (!sessionId) throw new Error("Rollout filename has no session id");
  const hash = createHash("sha256");
  const input = createReadStream(file.path);
  input.on("data", (chunk: Buffer) => hash.update(chunk));
  const lines = createInterface({ input, crlfDelay: Infinity });
  let validJsonLines = 0;
  let lineNumber = 0;
  let lastNonEmptyLine = 0;
  const invalidJsonLines: number[] = [];
  async function* observedLines(): AsyncGenerator<string> {
    for await (const line of lines) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        lastNonEmptyLine = lineNumber;
        try {
          JSON.parse(trimmed);
          validJsonLines += 1;
        } catch {
          invalidJsonLines.push(lineNumber);
          // An active rollout can end in one incomplete line. The parser and
          // fingerprint still describe the complete prefix; a wholly damaged
          // file remains invalid and loses selection to the next candidate.
        }
      }
      yield line;
    }
  }
  const estimate = await aggregateCodexCostLines(observedLines(), {
    sinceMs: 0,
    historySinceMs: 0,
    nowMs,
  });
  const startedAt = startedAtFromPath(file.path);
  return {
    sourceId: "",
    path: file.path,
    sessionId,
    size: file.size,
    mtimeMs: file.mtimeMs,
    parserVersion: CODEX_USAGE_HISTORY_PARSER_VERSION,
    fingerprint: hash.digest("hex"),
    valid: validJsonLines > 0 && invalidJsonLines.every((invalid) => invalid === lastNonEmptyLine),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(estimate ? { estimate } : {}),
  };
}

function compareCandidates(a: IndexedFile, b: IndexedFile): number {
  return (
    b.size - a.size ||
    b.mtimeMs - a.mtimeMs ||
    b.fingerprint.localeCompare(a.fingerprint) ||
    a.path.localeCompare(b.path)
  );
}

export function selectPreferredCodexUsageFile(
  candidates: readonly IndexedFile[],
): IndexedFile | undefined {
  return candidates.filter((candidate) => candidate.valid).sort(compareCandidates)[0];
}

function totalTokens(tokens: UsageTokens): number {
  return (
    tokens.total ??
    (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0)
  );
}

function repriceModel(model: UsageHistoryModel): UsageHistoryModel {
  const resolved = resolveModelRate(model.model);
  const count = totalTokens(model.tokens);
  return {
    ...model,
    tokens: {
      ...model.tokens,
      total: count,
      priced: resolved ? count : 0,
      proxyPriced: resolved?.kind === "proxy" ? count : 0,
    },
    estimatedCostUsd: priceTokens(model.model, model.tokens),
  };
}

function repriceMonth(month: UsageHistoryMonth): UsageHistoryMonth {
  const models = month.models.map(repriceModel);
  const sum = (key: keyof UsageTokens): number =>
    models.reduce(
      (total, model) => total + (typeof model.tokens[key] === "number" ? model.tokens[key] : 0),
      0,
    );
  return {
    ...month,
    tokens: {
      total: sum("total"),
      input: sum("input"),
      output: sum("output"),
      cacheRead: sum("cacheRead"),
      cacheWrite: sum("cacheWrite"),
      priced: sum("priced"),
      proxyPriced: sum("proxyPriced"),
    },
    estimatedCostUsd: models.reduce((total, model) => total + model.estimatedCostUsd, 0),
    models,
  };
}

function repriceEstimate(estimate: CostEstimate): CostEstimate {
  const history: UsageHistory | undefined = estimate.history
    ? { months: estimate.history.months.map(repriceMonth) }
    : undefined;
  if (!history) return estimate;
  const months = history.months;
  const sum = (key: keyof UsageTokens): number =>
    months.reduce(
      (total, month) => total + (typeof month.tokens[key] === "number" ? month.tokens[key] : 0),
      0,
    );
  const top = months
    .flatMap((month) => month.models)
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)[0];
  return {
    cost: {
      currency: "USD",
      amount: months.reduce((total, month) => total + month.estimatedCostUsd, 0),
      period: "30d",
      estimated: true,
    },
    tokens: {
      total: sum("total"),
      input: sum("input"),
      output: sum("output"),
      cacheRead: sum("cacheRead"),
      cacheWrite: sum("cacheWrite"),
      priced: sum("priced"),
      proxyPriced: sum("proxyPriced"),
      period: "30d",
    },
    ...(top ? { topModel: top.model } : {}),
    history,
  };
}

function reasoningTokens(history: UsageHistory | undefined): number {
  return (history?.months ?? []).reduce((total, month) => total + (month.reasoningTokens ?? 0), 0);
}

function summaryFromFile(file: IndexedFile, source: PersistedSource): UsageHistorySessionSummary {
  const estimate = file.estimate ? repriceEstimate(file.estimate) : undefined;
  const tokens = estimate?.tokens ?? { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const { period: _period, ...allTimeTokens } = tokens;
  const thinking = reasoningTokens(estimate?.history);
  return {
    sessionId: file.sessionId,
    sourceId: file.sourceId,
    machine: source.machine,
    fileSize: file.size,
    modifiedAt: file.mtimeMs,
    fingerprint: file.fingerprint,
    ...(file.startedAt !== undefined ? { startedAt: file.startedAt } : {}),
    tokens: allTimeTokens,
    ...(thinking > 0 ? { reasoningTokens: thinking } : {}),
    estimatedCostUsd: estimate?.cost.amount ?? 0,
    ...(estimate?.history ? { history: estimate.history } : {}),
  };
}

function isPersistedIndex(value: unknown): value is PersistedIndex {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedIndex>;
  return (
    candidate.version === CODEX_USAGE_HISTORY_INDEX_VERSION &&
    candidate.providerId === PROVIDER_ID &&
    typeof candidate.machine === "string" &&
    Boolean(candidate.sources && typeof candidate.sources === "object") &&
    Boolean(candidate.files && typeof candidate.files === "object")
  );
}

export class CodexUsageHistoryIndex implements UsageHistoryProvider {
  readonly providerId = PROVIDER_ID;
  private readonly now: () => number;
  private readonly codexHome: string;
  private readonly machine: string;
  private index: PersistedIndex;
  private loaded = false;
  private backgroundStarted = false;
  private refreshInFlight: Promise<UsageHistoryDigest> | undefined;

  constructor(private readonly options: CodexUsageHistoryIndexOptions) {
    this.now = options.now ?? Date.now;
    this.codexHome = normalize(options.codexHome ?? resolveDefaultCodexHome());
    this.machine = options.machine?.trim() || hostname();
    this.index = emptyIndex(this.machine);
  }

  private configuredSources(): ConfiguredSource[] {
    const defaults: ConfiguredSource[] = [
      {
        id: "default-sessions",
        name: "Sessions",
        path: join(this.codexHome, "sessions"),
        kind: "sessions",
        enabled: true,
      },
      {
        id: "default-archived-sessions",
        name: "Archived sessions",
        path: join(this.codexHome, "archived_sessions"),
        kind: "archived-sessions",
        enabled: true,
      },
    ];
    const usedIds = new Set(defaults.map((source) => source.id));
    const additional = this.options.readAdditionalSources().flatMap((source) => {
      const path = normalize(resolveHomePath(source.path));
      if (usedIds.has(source.id) || !isAbsolute(path)) return [];
      usedIds.add(source.id);
      return [
        {
          id: source.id,
          name: source.name,
          path,
          kind: "archive" as const,
          enabled: source.enabled,
        },
      ];
    });
    return [...defaults, ...additional];
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.indexPath, "utf8"));
      if (!isPersistedIndex(parsed)) return;
      this.index = parsed;
      this.index.machine = this.machine;
      if (
        this.index.pricingReviewedAt !== PRICING_TABLE_REVIEWED ||
        this.index.pricingRevision !== PRICING_TABLE_REVISION
      ) {
        for (const file of Object.values(this.index.files)) {
          if (file.estimate) file.estimate = repriceEstimate(file.estimate);
        }
        this.index.pricingReviewedAt = PRICING_TABLE_REVIEWED;
        this.index.pricingRevision = PRICING_TABLE_REVISION;
      }
    } catch {
      // Missing, old, or damaged derived indexes are rebuilt from source logs.
    }
    this.syncConfiguredSources();
  }

  private syncConfiguredSources(): void {
    const configured = this.configuredSources();
    const configuredIds = new Set(configured.map((source) => source.id));
    for (const source of configured) {
      const previous = this.index.sources[source.id];
      this.index.sources[source.id] = {
        ...source,
        machine: this.machine,
        status: source.enabled ? (previous?.status ?? "offline") : "disabled",
        ...(previous?.lastIndexedAt !== undefined ? { lastIndexedAt: previous.lastIndexedAt } : {}),
      };
    }
    for (const sourceId of Object.keys(this.index.sources)) {
      if (configuredIds.has(sourceId)) continue;
      delete this.index.sources[sourceId];
      for (const [key, file] of Object.entries(this.index.files)) {
        if (file.sourceId === sourceId) delete this.index.files[key];
      }
    }
  }

  private selectedFiles(sourceIds?: readonly string[]): IndexedFile[] {
    const allowed = sourceIds ? new Set(sourceIds) : undefined;
    const groups = new Map<string, IndexedFile[]>();
    for (const file of Object.values(this.index.files)) {
      const source = this.index.sources[file.sourceId];
      if (!source?.enabled || (allowed && !allowed.has(file.sourceId))) continue;
      const group = groups.get(file.sessionId) ?? [];
      group.push(file);
      groups.set(file.sessionId, group);
    }
    return [...groups.values()].flatMap((group) => {
      const selected = selectPreferredCodexUsageFile(group);
      return selected ? [selected] : [];
    });
  }

  private sourceDigest(source: PersistedSource): UsageHistorySourceDigest {
    const files = Object.values(this.index.files).filter((file) => file.sourceId === source.id);
    const uniqueSessions = new Set(files.filter((file) => file.valid).map((file) => file.sessionId))
      .size;
    return {
      id: source.id,
      name: source.name,
      machine: source.machine,
      path: source.path,
      kind: source.kind,
      status: source.status,
      uniqueSessions,
      candidateFiles: files.length,
      ...(source.lastIndexedAt !== undefined ? { lastIndexedAt: source.lastIndexedAt } : {}),
      ...(source.processedFiles !== undefined ? { processedFiles: source.processedFiles } : {}),
      ...(source.totalFiles !== undefined ? { totalFiles: source.totalFiles } : {}),
    };
  }

  private currentDigest(): UsageHistoryDigest {
    const selected = this.selectedFiles();
    const digest = createHash("sha256")
      .update(
        `index:${CODEX_USAGE_HISTORY_INDEX_VERSION}:parser:${CODEX_USAGE_HISTORY_PARSER_VERSION}:pricing:${PRICING_TABLE_REVISION}|`,
      )
      .update(
        selected
          .map((file) => `${file.sessionId}:${file.fingerprint}`)
          .sort()
          .join("|"),
      )
      .digest("hex");
    const started = selected
      .map((file) => file.startedAt)
      .filter((value): value is number => value !== undefined);
    const sourceValues = Object.values(this.index.sources);
    const indexed = sourceValues
      .map((source) => source.lastIndexedAt)
      .filter((value): value is number => value !== undefined);
    return {
      providerId: PROVIDER_ID,
      indexVersion: CODEX_USAGE_HISTORY_INDEX_VERSION,
      digest,
      machine: this.machine,
      uniqueSessions: selected.length,
      candidateFiles: Object.keys(this.index.files).length,
      ...(started.length > 0 ? { earliestSessionAt: Math.min(...started) } : {}),
      ...(indexed.length > 0 ? { lastIndexedAt: Math.max(...indexed) } : {}),
      indexing: sourceValues.some((source) => source.status === "indexing"),
      sources: sourceValues.map((source) => this.sourceDigest(source)),
    };
  }

  private async persist(): Promise<void> {
    this.index.savedAt = this.now();
    await mkdir(dirname(this.options.indexPath), { recursive: true });
    const tempPath = `${this.options.indexPath}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.index), "utf8");
    await rename(tempPath, this.options.indexPath);
  }

  private async scanSource(source: PersistedSource): Promise<void> {
    if (!source.enabled) {
      source.status = "disabled";
      return;
    }
    source.status = "indexing";
    source.processedFiles = 0;
    delete source.totalFiles;
    const files = await collectRolloutFiles(source.path);
    if (!files) {
      source.status = "offline";
      delete source.processedFiles;
      return;
    }
    source.totalFiles = files.length;
    const seen = new Set<string>();
    let filesSinceCheckpoint = 0;
    let lastCheckpointAt = Date.now();
    for (const file of files) {
      const key = sourceFileKey(source.id, file.path);
      seen.add(key);
      const cached = this.index.files[key];
      if (
        cached?.size === file.size &&
        cached.mtimeMs === file.mtimeMs &&
        cached.parserVersion === CODEX_USAGE_HISTORY_PARSER_VERSION
      ) {
        source.processedFiles = (source.processedFiles ?? 0) + 1;
        continue;
      }
      try {
        this.options.onParseFile?.(file.path);
        const parsed = await parseRollout(file, this.now());
        parsed.sourceId = source.id;
        this.index.files[key] = parsed;
      } catch {
        // Preserve a prior valid candidate if a concurrently-written file could
        // not be read. A new unreadable file is retried on the next refresh.
      }
      source.processedFiles = (source.processedFiles ?? 0) + 1;
      filesSinceCheckpoint += 1;
      const checkpointAt = Date.now();
      if (
        filesSinceCheckpoint >= CHECKPOINT_FILE_INTERVAL ||
        checkpointAt - lastCheckpointAt >= CHECKPOINT_TIME_INTERVAL_MS
      ) {
        // A first pass can read tens of gigabytes. Persist completed file
        // aggregates while scanning so an app/helper restart only repeats the
        // currently active file plus cheap metadata checks for prior files.
        await this.persist();
        filesSinceCheckpoint = 0;
        lastCheckpointAt = checkpointAt;
      }
    }
    for (const [key, indexed] of Object.entries(this.index.files)) {
      if (indexed.sourceId === source.id && !seen.has(key)) delete this.index.files[key];
    }
    source.status = "online";
    source.lastIndexedAt = this.now();
    delete source.processedFiles;
    delete source.totalFiles;
  }

  private async runRefresh(sourceId?: string): Promise<UsageHistoryDigest> {
    await this.load();
    this.syncConfiguredSources();
    const sources = Object.values(this.index.sources).filter(
      (source) => sourceId === undefined || source.id === sourceId,
    );
    for (const source of sources) await this.scanSource(source);
    await this.persist();
    return this.currentDigest();
  }

  private startBackgroundRefresh(): void {
    if (this.backgroundStarted) return;
    this.backgroundStarted = true;
    this.syncConfiguredSources();
    for (const source of Object.values(this.index.sources)) {
      if (source.enabled) source.status = "indexing";
    }
    void this.refresh({ providerId: PROVIDER_ID }).catch(() => undefined);
  }

  async getDigest(): Promise<UsageHistoryDigest> {
    await this.load();
    this.startBackgroundRefresh();
    return this.currentDigest();
  }

  async getPage(payload: UsageHistoryPagePayload): Promise<UsageHistoryPageResponse> {
    await this.load();
    const selected = this.selectedFiles(payload.sourceIds).sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId),
    );
    const parsedCursor = Number(payload.cursor ?? "0");
    const offset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
    const limit = payload.limit ?? DEFAULT_PAGE_SIZE;
    const page = selected.slice(offset, offset + limit);
    const digest = this.currentDigest().digest;
    return {
      digest,
      sessions: page.flatMap((file) => {
        const source = this.index.sources[file.sourceId];
        return source ? [summaryFromFile(file, source)] : [];
      }),
      ...(offset + page.length < selected.length
        ? { nextCursor: String(offset + page.length) }
        : {}),
    };
  }

  async refresh(payload: RefreshUsageHistoryPayload): Promise<UsageHistoryDigest> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.backgroundStarted = true;
    const promise = this.runRefresh(payload.sourceId).finally(() => {
      if (this.refreshInFlight === promise) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = promise;
    return promise;
  }

  getCachedAggregate(): UsageHistoryAggregate | undefined {
    if (!this.loaded) return undefined;
    const estimate = mergeCostEstimates(this.selectedFiles().map((file) => file.estimate));
    if (!estimate) return undefined;
    const thinking = reasoningTokens(estimate.history);
    const { period: _period, ...allTimeTokens } = estimate.tokens;
    return {
      tokens: allTimeTokens,
      ...(thinking > 0 ? { reasoningTokens: thinking } : {}),
      estimatedCostUsd: estimate.cost.amount,
      ...(estimate.history ? { history: estimate.history } : {}),
    };
  }
}
