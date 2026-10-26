import type {
  AgentInstanceConfig,
  AgentStatus,
  ThreadConfig,
  ThreadPresentationMode,
  UsageSnapshot,
} from "@/shared/contracts";

export interface AntigravityQuotaFailoverInput {
  agentKind: string;
  config: ThreadConfig;
  presentationMode?: ThreadPresentationMode;
  instances: readonly AgentInstanceConfig[];
  statuses: readonly AgentStatus[];
  snapshots: Readonly<Record<string, UsageSnapshot>>;
}

export interface AntigravityQuotaFailoverResult {
  agentKind: string;
  switchedFrom?: string;
  label?: string;
}

function quotaPool(model: string | undefined): "gemini" | "claude" {
  return /^(claude|gpt)\b/i.test(model?.trim() ?? "") ? "claude" : "gemini";
}

function relevantWindows(snapshot: UsageSnapshot | undefined, pool: "gemini" | "claude") {
  const prefix = `antigravity:${pool}:`;
  return snapshot?.windows.filter((window) => window.id.startsWith(prefix)) ?? [];
}

function quotaExhausted(snapshot: UsageSnapshot | undefined, pool: "gemini" | "claude"): boolean {
  if (snapshot?.status !== "ok") return false;
  const windows = relevantWindows(snapshot, pool);
  return windows.length > 0 && windows.some((window) => window.usedPercent >= 100);
}

function quotaAvailable(snapshot: UsageSnapshot | undefined, pool: "gemini" | "claude"): boolean {
  if (snapshot?.status !== "ok") return false;
  const windows = relevantWindows(snapshot, pool);
  return windows.length > 0 && windows.every((window) => window.usedPercent < 100);
}

/**
 * Pick the next authenticated Antigravity CLI profile for a new terminal
 * thread after the selected account has a confirmed exhausted quota window.
 * Unknown/stale usage never triggers a switch.
 */
export function resolveAntigravityQuotaFailover(
  input: AntigravityQuotaFailoverInput,
): AntigravityQuotaFailoverResult {
  if (input.presentationMode === "gui") return { agentKind: input.agentKind };
  const pool = quotaPool(input.config.model);
  if (!quotaExhausted(input.snapshots[input.agentKind], pool)) {
    return { agentKind: input.agentKind };
  }

  const profiles = input.instances
    .filter((instance) => instance.enabled !== false && instance.driver === "antigravity")
    .map((instance) => ({
      kind: `antigravity:${instance.id}`,
      label: instance.displayName ?? instance.id,
    }));
  const accounts = [{ kind: "antigravity", label: "Antigravity" }, ...profiles];
  const currentIndex = accounts.findIndex((account) => account.kind === input.agentKind);
  const ordered =
    currentIndex >= 0
      ? [...accounts.slice(currentIndex + 1), ...accounts.slice(0, currentIndex)]
      : accounts;

  const candidate = ordered.find((account) => {
    const status = input.statuses.find((entry) => entry.kind === account.kind);
    return (
      status?.installed === true &&
      status.authState === "authenticated" &&
      quotaAvailable(input.snapshots[account.kind], pool)
    );
  });
  return candidate
    ? { agentKind: candidate.kind, switchedFrom: input.agentKind, label: candidate.label }
    : { agentKind: input.agentKind };
}
