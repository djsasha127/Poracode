import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  UsageHistoryDigest,
  UsageHistoryPageResponse,
  UsageHistorySessionSummary,
} from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";
import { Button, Select, type SelectOption } from "@/renderer/components/common";
import { useRemoteServersStore } from "@/renderer/state/remoteServersStore";
import { UsageMonthlyHistory } from "../UsageMonthlyHistory";
import { formatEstimatedMoney, formatTokens } from "../usageFormat";
import type { UsageHistoryPanelExtensionProps } from "../usageHistoryExtensions";
import { aggregateUsageHistorySessions, mergeUsageHistorySessions } from "./usageHistoryData";

const PROVIDER_ID = "codex";
const PAGE_SIZE = 500;
type Scope = "all" | "local" | "remote" | `local-source:${string}` | `remote-source:${string}`;

interface HostHistoryState {
  digest?: UsageHistoryDigest;
  sessions: UsageHistorySessionSummary[];
  unavailable?: boolean;
}

async function readAllPages(
  read: (cursor?: string) => Promise<UsageHistoryPageResponse>,
): Promise<UsageHistorySessionSummary[]> {
  const sessions: UsageHistorySessionSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    sessions.push(...page.sessions);
    cursor = page.nextCursor;
  } while (cursor);
  return sessions;
}

function sourceIdsForScope(
  scope: Scope,
  side: "local" | "remote",
  digest: UsageHistoryDigest | undefined,
): string[] | undefined {
  if (scope === "all") return undefined;
  if (scope === side) {
    return digest?.sources.filter((source) => source.kind !== "archive").map((source) => source.id);
  }
  const prefix = `${side}-source:`;
  return scope.startsWith(prefix) ? [scope.slice(prefix.length)] : [];
}

function includesSide(scope: Scope, side: "local" | "remote"): boolean {
  return scope === "all" || scope === side || scope.startsWith(`${side}-source:`);
}

function newestIndexedAt(digests: readonly (UsageHistoryDigest | undefined)[]): number | undefined {
  const values = digests
    .map((digest) => digest?.lastIndexedAt)
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

export function CodexUsageHistory(props: UsageHistoryPanelExtensionProps) {
  const { t } = useLingui();
  const [scope, setScope] = useState<Scope>("all");
  const [local, setLocal] = useState<HostHistoryState>({ sessions: [] });
  const [remote, setRemote] = useState<HostHistoryState>({ sessions: [] });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const localPromise = readBridge()
        .getUsageHistoryDigest({ providerId: PROVIDER_ID })
        .then((digest) => ({ digest, unavailable: false as const }))
        .catch(() => ({ digest: undefined, unavailable: true as const }));
      const remotePromise = props.remoteServerId
        ? useRemoteServersStore
            .getState()
            .withClient(props.remoteServerId, (client) => client.usageHistoryDigest(PROVIDER_ID))
            .then((digest) => ({ digest, unavailable: false as const }))
            .catch(() => ({ digest: undefined, unavailable: true as const }))
        : Promise.resolve({ digest: undefined, unavailable: false as const });
      const [localResult, remoteResult] = await Promise.all([localPromise, remotePromise]);
      if (cancelled) return;
      setLocal((previous) => ({
        ...previous,
        ...(localResult.digest ? { digest: localResult.digest } : {}),
        unavailable: localResult.unavailable,
      }));
      setRemote((previous) => ({
        ...previous,
        ...(remoteResult.digest ? { digest: remoteResult.digest } : {}),
        unavailable: remoteResult.unavailable,
      }));
      if (localResult.digest?.indexing || remoteResult.digest?.indexing) {
        timer = window.setTimeout(() => void poll(), 750);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [props.remoteServerId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const localSourceIds = sourceIdsForScope(scope, "local", local.digest);
      const remoteSourceIds = sourceIdsForScope(scope, "remote", remote.digest);
      const localPromise = includesSide(scope, "local")
        ? readAllPages((cursor) =>
            readBridge().getUsageHistoryPage({
              providerId: PROVIDER_ID,
              limit: PAGE_SIZE,
              ...(cursor ? { cursor } : {}),
              ...(localSourceIds ? { sourceIds: localSourceIds } : {}),
            }),
          ).catch(() => [])
        : Promise.resolve([]);
      const remotePromise =
        props.remoteServerId && includesSide(scope, "remote")
          ? readAllPages((cursor) =>
              useRemoteServersStore.getState().withClient(props.remoteServerId!, (client) =>
                client.usageHistoryPage({
                  providerId: PROVIDER_ID,
                  limit: PAGE_SIZE,
                  ...(cursor ? { cursor } : {}),
                  ...(remoteSourceIds ? { sourceIds: remoteSourceIds } : {}),
                }),
              ),
            ).catch(() => [])
          : Promise.resolve([]);
      const [localSessions, remoteSessions] = await Promise.all([localPromise, remotePromise]);
      if (cancelled) return;
      setLocal((previous) => ({ ...previous, sessions: localSessions }));
      setRemote((previous) => ({ ...previous, sessions: remoteSessions }));
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [local.digest, remote.digest, props.remoteServerId, scope]);

  const options: SelectOption[] = [
    { id: "all", label: t`All sources` },
    { id: "local", label: t`This Mac` },
    ...(props.remoteServerId
      ? [{ id: "remote", label: props.remoteSourceLabel ?? props.remoteServerId }]
      : []),
    ...(local.digest?.sources ?? [])
      .filter((source) => source.kind === "archive")
      .map((source) => ({
        id: `local-source:${source.id}`,
        label: source.name,
        detail: source.status === "offline" ? t`Archive offline` : source.path,
      })),
    ...(remote.digest?.sources ?? [])
      .filter((source) => source.kind === "archive")
      .map((source) => ({
        id: `remote-source:${source.id}`,
        label: source.name,
        detail: source.status === "offline" ? t`Archive offline` : source.path,
      })),
  ];
  const sessions = mergeUsageHistorySessions([local.sessions, remote.sessions]);
  const aggregate = aggregateUsageHistorySessions(sessions);
  const proxyPricedTokens = aggregate?.tokens.proxyPriced ?? 0;
  const unpricedTokens = Math.max(
    0,
    (aggregate?.tokens.total ?? 0) - (aggregate?.tokens.priced ?? aggregate?.tokens.total ?? 0),
  );
  const sourceDigests = [
    ...(includesSide(scope, "local") ? (local.digest?.sources ?? []) : []),
    ...(includesSide(scope, "remote") ? (remote.digest?.sources ?? []) : []),
  ].filter((source) => {
    if (scope === "all") return true;
    if (scope === "local" || scope === "remote") return source.kind !== "archive";
    return scope.endsWith(`source:${source.id}`);
  });
  const indexing = sourceDigests.some((source) => source.status === "indexing");
  const offlineArchive = sourceDigests.some(
    (source) => source.kind === "archive" && source.status === "offline",
  );
  const indexedAt = newestIndexedAt([
    ...(includesSide(scope, "local") ? [local.digest] : []),
    ...(includesSide(scope, "remote") ? [remote.digest] : []),
  ]);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const requests: Promise<unknown>[] = [];
      if (includesSide(scope, "local")) {
        requests.push(readBridge().refreshUsageHistory({ providerId: PROVIDER_ID }));
      }
      if (props.remoteServerId && includesSide(scope, "remote")) {
        requests.push(
          useRemoteServersStore
            .getState()
            .withClient(props.remoteServerId, (client) =>
              client.refreshUsageHistory({ providerId: PROVIDER_ID }),
            ),
        );
      }
      await Promise.allSettled(requests);
      const [localDigest, remoteDigest] = await Promise.all([
        readBridge()
          .getUsageHistoryDigest({ providerId: PROVIDER_ID })
          .catch(() => undefined),
        props.remoteServerId
          ? useRemoteServersStore
              .getState()
              .withClient(props.remoteServerId, (client) => client.usageHistoryDigest(PROVIDER_ID))
              .catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      if (localDigest) setLocal((previous) => ({ ...previous, digest: localDigest }));
      if (remoteDigest) setRemote((previous) => ({ ...previous, digest: remoteDigest }));
    } finally {
      setRefreshing(false);
    }
  };

  if (local.unavailable && (!props.remoteServerId || remote.unavailable)) return null;
  return (
    <div className="space-y-1.5 border-t border-[color:var(--separator)] pt-2">
      <div className="flex items-center gap-1.5">
        <Select
          aria-label={t`Usage history source`}
          className="min-w-0 flex-1"
          options={options}
          value={scope}
          onChange={(value) => setScope(value as Scope)}
        />
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t`Refresh usage history`}
          isDisabled={refreshing || indexing}
          onPress={() => void refresh()}
        >
          <RefreshCw className={`size-3.5 ${refreshing || indexing ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-2 text-[10px] text-muted/70">
        <span>
          <Trans>{sessions.length} unique sessions</Trans>
          {indexing ? ` · ${t`Indexing`}` : ""}
          {offlineArchive ? ` · ${t`Archive offline`}` : ""}
        </span>
        {indexedAt ? (
          <span title={new Date(indexedAt).toLocaleString()}>
            <Trans>Indexed {new Date(indexedAt).toLocaleDateString()}</Trans>
          </span>
        ) : null}
      </div>
      {aggregate ? (
        <div className="space-y-0.5">
          <div className="grid grid-cols-2 gap-x-3 text-[10px] text-muted/80">
            <span>
              <Trans>All-time tokens</Trans> {formatTokens(aggregate.tokens.total)}
            </span>
            <span className="text-right tabular-nums">
              <Trans>API-rate equivalent</Trans> ~{formatEstimatedMoney(aggregate.estimatedCostUsd)}
            </span>
          </div>
          {proxyPricedTokens > 0 || unpricedTokens > 0 ? (
            <p className="text-[9px] leading-tight text-muted/60">
              {[
                proxyPricedTokens > 0
                  ? t`${formatTokens(proxyPricedTokens)} tokens use a public proxy rate`
                  : undefined,
                unpricedTokens > 0
                  ? t`${formatTokens(unpricedTokens)} tokens are unpriced`
                  : undefined,
              ]
                .filter((note): note is string => Boolean(note))
                .join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}
      {aggregate?.history ? <UsageMonthlyHistory history={aggregate.history} /> : null}
      <details className="text-[10px] text-muted/70">
        <summary className="cursor-pointer">
          <Trans>Sources</Trans>
        </summary>
        <div className="mt-1 space-y-1">
          {sourceDigests.map((source) => (
            <div
              key={`${source.machine}:${source.id}`}
              className="flex items-start justify-between gap-2"
            >
              <span className="min-w-0" title={source.path}>
                <span className="block truncate">
                  {source.kind === "sessions"
                    ? t`Sessions`
                    : source.kind === "archived-sessions"
                      ? t`Archived sessions`
                      : source.name}
                </span>
                <span className="block truncate text-[9px] text-muted/50">{source.machine}</span>
              </span>
              <span className="shrink-0 text-right tabular-nums">
                <span className="block">
                  {source.uniqueSessions} ·{" "}
                  {source.status === "online"
                    ? t`Online`
                    : source.status === "offline"
                      ? t`Offline`
                      : source.status === "disabled"
                        ? t`Disabled`
                        : source.totalFiles !== undefined
                          ? `${t`Indexing`} ${source.processedFiles ?? 0}/${source.totalFiles}`
                          : t`Indexing`}
                </span>
                {source.lastIndexedAt ? (
                  <span className="block text-[9px] text-muted/50">
                    <Trans>Indexed {new Date(source.lastIndexedAt).toLocaleString()}</Trans>
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
