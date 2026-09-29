import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  aggregateClaudeCostLines,
  aggregateCodexCostLines,
  mergeCostEstimates,
  type CostEstimate,
} from "@poracode/agents-usage";
import { claudeConfigDirs } from "./claudeCredentials";

/**
 * Supervisor-side estimated-cost scanner. Reads Claude Code session JSONL from
 * ~/.claude/projects and hands streamed lines to the package's pure aggregator.
 * Only runs when the user enables estimated cost.
 *
 * Cached per file: historical logs can span multiple gigabytes, so every file
 * is streamed once and memoized on (path, mtime, size, rolling-window day).
 * Native host only — WSL-side logs are out of scope.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface FileRef {
  path: string;
  mtimeMs: number;
  size: number;
}

interface ClaudeCostEnv {
  CLAUDE_CONFIG_DIR?: string | undefined;
}

function claudeProjectsDirs(env: ClaudeCostEnv = process.env): string[] {
  return claudeConfigDirs(env).map((dir) => join(dir, "projects"));
}

async function safeReaddir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function collectClaudeLogs(env?: ClaudeCostEnv): Promise<FileRef[]> {
  const files: FileRef[] = [];
  for (const dir of claudeProjectsDirs(env)) {
    for (const project of await safeReaddir(dir)) {
      if (!project.isDirectory()) continue;
      const projectDir = join(dir, project.name);
      for (const entry of await safeReaddir(projectDir)) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const path = join(projectDir, entry.name);
        try {
          const st = await stat(path);
          files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  return files;
}

async function collectJsonlRecursive(dir: string, depth = 0): Promise<FileRef[]> {
  if (depth > 6) return [];
  const files: FileRef[] = [];
  for (const entry of await safeReaddir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlRecursive(path, depth + 1)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const st = await stat(path);
      files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // unreadable file — skip
    }
  }
  return files;
}

export interface ClaudeCostScan {
  estimate: CostEstimate | undefined;
  /** Retained for the UI contract; streamed scans do not truncate by bytes. */
  truncated: boolean;
}

const claudeCache = new Map<string, { signature: string; result: ClaudeCostScan }>();
const codexCache = new Map<string, { signature: string; result: ClaudeCostScan }>();
const claudeFileCache = new Map<
  string,
  { signature: string; windowDay: number; estimate: CostEstimate | undefined }
>();
const codexFileCache = new Map<
  string,
  { signature: string; windowDay: number; estimate: CostEstimate | undefined }
>();

function signatureOf(files: readonly FileRef[]): string {
  return files
    .map((f) => `${f.path}:${f.mtimeMs}:${f.size}`)
    .sort()
    .join("|");
}

/**
 * Estimate Claude 30-day cost + tokens from local logs. Memoized on the log
 * tree's signature, so repeated calls with unchanged logs are free.
 */
export async function scanClaudeCost(nowMs: number, env?: ClaudeCostEnv): Promise<ClaudeCostScan> {
  const sinceMs = nowMs - THIRTY_DAYS_MS;
  const files = await collectClaudeLogs(env);
  const windowDay = Math.floor(sinceMs / (24 * 60 * 60 * 1000));
  const signature = `${windowDay}|${signatureOf(files)}`;
  const cacheKey = claudeProjectsDirs(env).sort().join("|");
  const cachedScan = claudeCache.get(cacheKey);
  if (cachedScan?.signature === signature) return cachedScan.result;

  const estimates: Array<CostEstimate | undefined> = [];
  for (const file of files) {
    const fileSignature = `${file.mtimeMs}:${file.size}`;
    const cached = claudeFileCache.get(file.path);
    if (cached?.signature === fileSignature && cached.windowDay === windowDay) {
      estimates.push(cached.estimate);
      continue;
    }

    let estimate: CostEstimate | undefined;
    try {
      const lines = createInterface({
        input: createReadStream(file.path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      estimate = await aggregateClaudeCostLines(lines, {
        sinceMs,
        historySinceMs: 0,
        nowMs,
      });
    } catch {
      // Unreadable or concurrently replaced transcript — retry on the next refresh.
    }
    claudeFileCache.set(file.path, { signature: fileSignature, windowDay, estimate });
    estimates.push(estimate);
  }

  const estimate = mergeCostEstimates(estimates);
  const result: ClaudeCostScan = { estimate, truncated: false };
  claudeCache.set(cacheKey, { signature, result });
  return result;
}

/**
 * Estimate Codex 30-day API-equivalent cost + tokens from rollout JSONL under
 * `<CODEX_HOME>/sessions`. `codexHome` is profile-aware; the base tile uses
 * `~/.codex`. The same streamed, per-file signature memoization applies.
 */
export async function scanCodexCost(
  nowMs: number,
  codexHome = join(homedir(), ".codex"),
): Promise<ClaudeCostScan> {
  const sinceMs = nowMs - THIRTY_DAYS_MS;
  const files = await collectJsonlRecursive(join(codexHome, "sessions"));
  // Keep the exact rolling window stable for one UTC day so unchanged multi-GB
  // histories remain cached. New/changed files still invalidate immediately.
  const windowDay = Math.floor(sinceMs / (24 * 60 * 60 * 1000));
  const signature = `${windowDay}|${signatureOf(files)}`;
  const cachedScan = codexCache.get(codexHome);
  if (cachedScan?.signature === signature) return cachedScan.result;

  const estimates: Array<CostEstimate | undefined> = [];
  for (const file of files) {
    const fileSignature = `${file.mtimeMs}:${file.size}`;
    const cached = codexFileCache.get(file.path);
    if (cached?.signature === fileSignature && cached.windowDay === windowDay) {
      estimates.push(cached.estimate);
      continue;
    }

    let estimate: CostEstimate | undefined;
    try {
      const lines = createInterface({
        input: createReadStream(file.path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      estimate = await aggregateCodexCostLines(lines, {
        sinceMs,
        historySinceMs: 0,
        nowMs,
      });
    } catch {
      // Unreadable or concurrently replaced rollout — omit this refresh and retry next time.
    }
    codexFileCache.set(file.path, { signature: fileSignature, windowDay, estimate });
    estimates.push(estimate);
  }

  const estimate = mergeCostEstimates(estimates);
  const result: ClaudeCostScan = { estimate, truncated: false };
  codexCache.set(codexHome, { signature, result });
  return result;
}
