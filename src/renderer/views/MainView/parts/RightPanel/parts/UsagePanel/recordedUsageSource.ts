import type { ProfileTokenProvider, ProfileTokenStats } from "@/shared/contracts";
import type { UsageSnapshot } from "@poracode/agents-usage/types";

export interface RecordedUsageSelection {
  usage: ProfileTokenProvider;
  stats: ProfileTokenStats;
  source: "local" | "remote";
}

/**
 * Full transcript scans cover the requested rolling window and preserve model
 * pricing. Prefer them over the legacy Poracode activity ledger, whose older
 * aggregate rows have no billable model/category metadata.
 */
export function hasScannedTokenHistory(snapshot: UsageSnapshot | undefined): boolean {
  return Boolean(snapshot?.tokens?.period === "30d" && (snapshot.tokens.total ?? 0) > 0);
}

function usageForProvider(
  stats: ProfileTokenStats | undefined,
  providerId: string,
): ProfileTokenProvider | undefined {
  if (!stats) return undefined;
  return (
    stats.accounts.find((entry) => entry.provider === providerId) ??
    stats.providers.find((entry) => entry.provider === providerId)
  );
}

/**
 * An open remote workspace should prefer token history measured on that host.
 * Subscription quota snapshots have their own freshness selection and must not
 * silently force the recorded-token row back to the local machine.
 */
export function selectRecordedUsage(
  providerId: string,
  localStats: ProfileTokenStats | undefined,
  remoteStats: ProfileTokenStats | undefined,
  hasRemoteContext: boolean,
): RecordedUsageSelection | undefined {
  if (hasRemoteContext && remoteStats) {
    const usage = usageForProvider(remoteStats, providerId);
    if (usage) return { usage, stats: remoteStats, source: "remote" };
  }

  if (!localStats) return undefined;
  const usage = usageForProvider(localStats, providerId);
  return usage ? { usage, stats: localStats, source: "local" } : undefined;
}
