import { startTransition, useEffect, useRef, useState } from "react";
import { DragDropProvider, type DragEndEvent } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { openUsageSettings } from "@/renderer/actions/panelActions";
import { readBridge } from "@/renderer/bridge";
import {
  resolveCombinedUsageSnapshot,
  resolveDisplayedProviders,
} from "@/renderer/components/providers/usageProviders";
import { useCurrentRemoteServerId } from "@/renderer/hooks/uiSelectors";
import { useScrollFade } from "@/renderer/hooks/useScrollFade";
import { useProviderUsageStore } from "@/renderer/state/providerUsageStore";
import { useRemoteServersStore } from "@/renderer/state/remoteServersStore";
import { useUsageLoginStateStore } from "@/renderer/state/usageLoginStateStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { UsageProviderCard } from "./parts/UsageProviderCard";
import { selectRecordedUsage } from "./recordedUsageSource";
import { resolveUsageRemoteServerId } from "./usageRemoteServer";
import type { TranslateFn } from "@/renderer/i18n/i18n";
import type { ProfileTokenStats } from "@/shared/contracts";

/** "Updated 12s ago" style relative label from an epoch-ms timestamp. */
function formatUpdatedAgo(fetchedAt: number, now: number, t: TranslateFn): string {
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 5) return t(msg`just now`);
  if (seconds < 60) return t(msg`${seconds}s ago`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t(msg`${minutes}m ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t(msg`${hours}h ago`);
  const days = Math.round(hours / 24);
  return t(msg`${days}d ago`);
}

export function UsagePanel(props: { onOpenUsageSettings?: (() => void) | undefined }) {
  const { t } = useLingui();
  const currentRemoteServerId = useCurrentRemoteServerId();
  const remoteServerId = useRemoteServersStore((state) =>
    resolveUsageRemoteServerId(currentRemoteServerId, state.servers, state.runtime),
  );
  const remoteSourceLabel = useRemoteServersStore((state) =>
    remoteServerId
      ? state.servers.find((server) => server.desktopId === remoteServerId)?.label
      : undefined,
  );
  const remoteUsage = useRemoteServersStore((state) =>
    remoteServerId ? state.runtime[remoteServerId]?.providerUsage : undefined,
  );
  const remoteTokenStats = useRemoteServersStore((state) =>
    remoteServerId ? state.runtime[remoteServerId]?.profileTokenStats : undefined,
  );
  const providerOrder = useSharedSettings((s) => s.usage.providerOrder);
  const disabledProviders = useSharedSettings((s) => s.usage.disabledProviders);
  const collapsedProviders = useSharedSettings((s) => s.usage.collapsedProviders);
  const agentInstances = useSharedSettings((s) => s.agentInstances);
  const setUsageSetting = useSharedSettings((s) => s.setUsageSetting);
  const localSnapshots = useProviderUsageStore((s) => s.snapshots);
  const remoteSnapshots = new Map(
    (remoteUsage?.snapshots ?? []).map((snapshot) => [snapshot.providerId, snapshot]),
  );
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [localTokenStats, setLocalTokenStats] = useState<ProfileTokenStats>();
  const contentRef = useRef<HTMLDivElement>(null);
  const { setScrollContainer, scrollFadeStyle } = useScrollFade<HTMLDivElement>({
    contentRef,
    maxFadePx: 10,
  });

  const displayed = resolveDisplayedProviders(providerOrder, disabledProviders, agentInstances);
  const displayedProviderIdsKey = displayed.map((provider) => provider.id).join("\u0000");

  // Hydrate the store from the supervisor cache on open (and let the cache's
  // staleness trigger a background refresh whose events update the cards live).
  // Alongside it, load the persistent "signed in" flags so the sign-in/out
  // affordance reflects the stored session, not whatever the last fetch returned.
  useEffect(() => {
    let cancelled = false;
    if (remoteServerId) {
      const providerIds = displayedProviderIdsKey.split("\u0000").filter(Boolean);
      void useRemoteServersStore.getState().refreshProviderUsage(remoteServerId, providerIds);
      void useRemoteServersStore.getState().refreshProfileTokenStats(remoteServerId);
    }
    void readBridge()
      .getProviderUsage({})
      .then((res) => {
        if (cancelled) return;
        const store = useProviderUsageStore.getState();
        for (const snapshot of res.snapshots) store.mergeSnapshot(snapshot);
      })
      .catch(() => undefined);
    void readBridge()
      .getProfileTokenStats({
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
        scope: "device",
        window: "all",
      })
      .then((stats) => {
        if (!cancelled) setLocalTokenStats(stats);
      })
      .catch(() => undefined);
    void readBridge()
      .getUsageLoginState({})
      .then((res) => {
        if (!cancelled) useUsageLoginStateStore.getState().setAll(res.stored);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [displayedProviderIdsKey, remoteServerId]);

  // Keep the single "Updated …" label fresh without re-fetching.
  useEffect(() => {
    const interval = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const lastUpdated = (() => {
    let max = 0;
    for (const provider of displayed) {
      const fetchedAt = remoteServerId
        ? resolveCombinedUsageSnapshot(
            localSnapshots[provider.id],
            remoteSnapshots.get(provider.id),
          ).snapshot?.fetchedAt
        : localSnapshots[provider.id]?.fetchedAt;
      if (fetchedAt && fetchedAt > max) max = fetchedAt;
    }
    return max;
  })();

  const openSettings = props.onOpenUsageSettings ?? openUsageSettings;

  const toggleCollapse = (id: string) => {
    const next = collapsedProviders.includes(id)
      ? collapsedProviders.filter((x) => x !== id)
      : [...new Set([...collapsedProviders, id])];
    startTransition(() => setUsageSetting("collapsedProviders", next));
  };

  function handleDragEnd(event: DragEndEvent) {
    if (event.canceled) return;
    const src = event.operation.source;
    if (!src || !isSortable(src)) return;
    const fromIndex = src.initialIndex;
    const toIndex = src.index;
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    const next = displayed.map((p) => p.id);
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);
    startTransition(() => setUsageSetting("providerOrder", next));
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--content-background)]">
      <div
        ref={setScrollContainer}
        className="min-h-0 flex-1 overflow-y-auto p-2.5 [scrollbar-gutter:stable]"
        style={scrollFadeStyle}
      >
        <div ref={contentRef} className="min-h-full">
          {remoteServerId ? (
            <p className="mb-2 px-1 text-[11px] text-muted/70">
              <Trans>Usage from {remoteSourceLabel ?? remoteServerId} and Local</Trans>
            </p>
          ) : null}
          {displayed.length === 0 ? (
            <div className="flex min-h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-sm text-muted">
                <Trans>No providers are being tracked.</Trans>
              </p>
              <button
                type="button"
                onClick={openSettings}
                className="text-xs text-accent underline-offset-2 hover:underline"
              >
                <Trans>Enable providers in settings</Trans>
              </button>
            </div>
          ) : (
            <DragDropProvider onDragEnd={handleDragEnd}>
              <div className="flex flex-col gap-2.5">
                {displayed.map((provider, index) => {
                  const selection = remoteServerId
                    ? resolveCombinedUsageSnapshot(
                        localSnapshots[provider.id],
                        remoteSnapshots.get(provider.id),
                      )
                    : { snapshot: localSnapshots[provider.id], source: "local" as const };
                  const usesRemote = Boolean(remoteServerId && selection.source === "remote");
                  const sourceLabel = remoteServerId
                    ? usesRemote
                      ? (remoteSourceLabel ?? remoteServerId)
                      : t`Local`
                    : undefined;
                  const recordedSelection = selectRecordedUsage(
                    provider.id,
                    localTokenStats,
                    remoteTokenStats,
                    Boolean(remoteServerId),
                  );
                  const recordedUsage = recordedSelection?.usage;
                  const recordedUsageSourceLabel = remoteServerId
                    ? recordedSelection?.source === "remote"
                      ? (remoteSourceLabel ?? remoteServerId)
                      : t`Local`
                    : undefined;
                  return (
                    <UsageProviderCard
                      key={provider.id}
                      id={provider.id}
                      label={provider.label}
                      index={index}
                      collapsed={collapsedProviders.includes(provider.id)}
                      onToggleCollapse={toggleCollapse}
                      snapshot={selection.snapshot}
                      {...(recordedUsage ? { recordedUsage } : {})}
                      {...(recordedSelection?.stats.pricingReviewedAt
                        ? { pricingReviewedAt: recordedSelection.stats.pricingReviewedAt }
                        : {})}
                      {...(recordedUsageSourceLabel ? { recordedUsageSourceLabel } : {})}
                      onRefreshRecordedUsage={() => {
                        const refreshLocal = () =>
                          readBridge()
                            .getProfileTokenStats({
                              utcOffsetMinutes: -new Date().getTimezoneOffset(),
                              scope: "device",
                              window: "all",
                            })
                            .then(setLocalTokenStats);
                        if (remoteServerId) {
                          return Promise.all([
                            useRemoteServersStore
                              .getState()
                              .refreshProfileTokenStats(remoteServerId),
                            refreshLocal(),
                          ]);
                        }
                        return refreshLocal();
                      }}
                      {...(usesRemote && remoteServerId ? { remoteServerId } : {})}
                      {...(sourceLabel ? { sourceLabel } : {})}
                      {...(remoteServerId ? { historyRemoteServerId: remoteServerId } : {})}
                      {...(remoteSourceLabel
                        ? { historyRemoteSourceLabel: remoteSourceLabel }
                        : {})}
                    />
                  );
                })}
              </div>
            </DragDropProvider>
          )}
        </div>
      </div>

      {lastUpdated > 0 ? (
        <div className="shrink-0 border-t border-[color:var(--separator)] px-3 py-1.5">
          <p className="text-[11px] text-muted/70">
            <Trans>Updated {formatUpdatedAgo(lastUpdated, nowTick, t)}</Trans>
          </p>
        </div>
      ) : null}
    </div>
  );
}
