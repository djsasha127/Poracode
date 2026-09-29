import { useEffect, useState } from "react";
import { FolderPlus, RefreshCw, Trash2 } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { UsageHistoryDigest } from "@/shared/contracts";
import type { UsageHistorySourceSetting } from "@/shared/settings";
import { defaultSharedSettings } from "@/shared/settings";
import { readBridge } from "@/renderer/bridge";
import {
  Button,
  Input,
  Select,
  ToggleSwitch,
  type SelectOption,
} from "@/renderer/components/common";
import { friendlyError } from "@/shared/messages";
import {
  useSharedSettings,
  waitForPendingSharedSettings,
} from "@/renderer/state/sharedSettingsStore";
import { useRemoteServersStore } from "@/renderer/state/remoteServersStore";
import { RemoteHostFolderPicker } from "@/renderer/views/SettingsOverlay/parts/RemoteHostFolderPicker";

const PROVIDER_ID = "codex";

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function CodexUsageHistorySettings() {
  const { t } = useLingui();
  const historySources = useSharedSettings((state) => state.usage.historySources);
  const setUsageSetting = useSharedSettings((state) => state.setUsageSetting);
  const remoteServers = useRemoteServersStore((state) => state.servers);
  const [selectedHost, setSelectedHost] = useState<string>("local");
  const [remoteSources, setRemoteSources] = useState<UsageHistorySourceSetting[]>([]);
  const [digest, setDigest] = useState<UsageHistoryDigest>();
  const [busySource, setBusySource] = useState<string>();
  const [error, setError] = useState<string>();
  const [showRemoteFolderPicker, setShowRemoteFolderPicker] = useState(false);
  const remoteDesktopId = selectedHost.startsWith("remote:")
    ? selectedHost.slice("remote:".length)
    : undefined;
  const sources = remoteDesktopId ? remoteSources : (historySources[PROVIDER_ID] ?? []);
  const hostOptions: SelectOption[] = [
    { id: "local", label: t`This Mac` },
    ...remoteServers.map((server) => ({ id: `remote:${server.desktopId}`, label: server.label })),
  ];

  useEffect(() => {
    let cancelled = false;
    if (!remoteDesktopId) {
      void readBridge()
        .getUsageHistoryDigest({ providerId: PROVIDER_ID })
        .then((next) => {
          if (!cancelled) setDigest(next);
        })
        .catch((loadError: unknown) => {
          if (!cancelled) setError(friendlyError(loadError));
        });
    } else {
      void useRemoteServersStore
        .getState()
        .withClient(remoteDesktopId, async (client) => {
          const [settings, nextDigest] = await Promise.all([
            client.settings(),
            client.usageHistoryDigest(PROVIDER_ID),
          ]);
          return {
            sources: settings.usage?.historySources[PROVIDER_ID] ?? [],
            digest: nextDigest,
          };
        })
        .then((result) => {
          if (cancelled) return;
          setRemoteSources(result.sources);
          setDigest(result.digest);
        })
        .catch((loadError: unknown) => {
          if (!cancelled) setError(friendlyError(loadError));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [remoteDesktopId]);

  const save = async (next: UsageHistorySourceSetting[]) => {
    if (!remoteDesktopId) {
      setUsageSetting("historySources", { ...historySources, [PROVIDER_ID]: next });
      await waitForPendingSharedSettings();
      return;
    }
    await useRemoteServersStore.getState().withClient(remoteDesktopId, async (client) => {
      const settings = await client.settings();
      const usage = settings.usage ?? defaultSharedSettings.usage;
      await client.updateSettings({
        usage: {
          ...usage,
          historySources: { ...usage.historySources, [PROVIDER_ID]: next },
        },
      });
    });
    setRemoteSources(next);
  };

  const refresh = async (sourceId?: string) => {
    setBusySource(sourceId ?? "all");
    setError(undefined);
    try {
      const payload = {
        providerId: PROVIDER_ID,
        ...(sourceId ? { sourceId } : {}),
      };
      const next = remoteDesktopId
        ? await useRemoteServersStore
            .getState()
            .withClient(remoteDesktopId, (client) => client.refreshUsageHistory(payload))
        : await readBridge().refreshUsageHistory(payload);
      setDigest(next);
    } catch (refreshError) {
      setError(friendlyError(refreshError));
    } finally {
      setBusySource(undefined);
    }
  };

  const update = async (sourceId: string, patch: Partial<UsageHistorySourceSetting>) => {
    try {
      await save(
        sources.map((source) => (source.id === sourceId ? { ...source, ...patch } : source)),
      );
      await refresh(sourceId);
    } catch (updateError) {
      setError(friendlyError(updateError));
    }
  };

  const addFolderPath = async (path: string) => {
    const source: UsageHistorySourceSetting = {
      id: `archive-${crypto.randomUUID()}`,
      name: folderName(path),
      path,
      enabled: true,
    };
    try {
      await save([...sources, source]);
      await refresh(source.id);
    } catch (addError) {
      setError(friendlyError(addError));
    }
  };

  const remove = async (sourceId: string) => {
    try {
      await save(sources.filter((entry) => entry.id !== sourceId));
      await refresh();
    } catch (removeError) {
      setError(friendlyError(removeError));
    }
  };

  const addFolder = async () => {
    if (remoteDesktopId) {
      setShowRemoteFolderPicker(true);
      return;
    }
    const path = await readBridge().pickFolder();
    if (path) await addFolderPath(path);
  };

  return (
    <section className="space-y-2 border-t border-border/10 pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            <Trans>Additional usage history folders</Trans>
          </p>
          <p className="text-xs text-muted">
            <Trans>
              Add read-only archives. Poracode stores only fingerprints and usage totals, never
              prompts, responses, or attachments.
            </Trans>
          </p>
        </div>
        <Button
          size="sm"
          variant="tertiary"
          aria-label={t`Add usage history folder`}
          onPress={() => void addFolder()}
        >
          <FolderPlus className="size-3.5" />
          <Trans>Add folder</Trans>
        </Button>
      </div>
      <Select
        aria-label={t`Usage history source`}
        options={hostOptions}
        value={selectedHost}
        onChange={(value) => {
          setError(undefined);
          setDigest(undefined);
          setRemoteSources([]);
          setSelectedHost(value);
        }}
      />
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {sources.length === 0 ? (
        <p className="text-xs text-muted/70">
          <Trans>No additional folders.</Trans>
        </p>
      ) : (
        <div className="space-y-2">
          {sources.map((source) => {
            const state = digest?.sources.find((entry) => entry.id === source.id);
            const busy = busySource === source.id || busySource === "all";
            const stateLabel = !state
              ? t`Not indexed`
              : state.status === "offline"
                ? t`Archive offline`
                : state.status === "online"
                  ? t`Online`
                  : state.status === "disabled"
                    ? t`Disabled`
                    : t`Indexing`;
            return (
              <div
                key={`${selectedHost}:${source.id}`}
                className="rounded-xl border border-[color:var(--separator)] bg-surface p-2.5"
              >
                <div className="flex items-center gap-2">
                  <ToggleSwitch
                    aria-label={t`Enable ${source.name}`}
                    isSelected={source.enabled}
                    onChange={(enabled) => {
                      void update(source.id, { enabled });
                    }}
                  />
                  <Input
                    aria-label={t`Usage history source name`}
                    className="min-w-0 flex-1"
                    defaultValue={source.name}
                    onBlur={(event) => {
                      const name = event.target.value.trim();
                      if (name) void update(source.id, { name });
                      else event.target.value = source.name;
                    }}
                  />
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={t`Check and rescan ${source.name}`}
                    isDisabled={busy}
                    onPress={() => void refresh(source.id)}
                  >
                    <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={t`Remove ${source.name}`}
                    isDisabled={busy}
                    onPress={() => void remove(source.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <p
                  className="mt-1 truncate font-mono text-[10px] text-muted/70"
                  title={source.path}
                >
                  {source.path}
                </p>
                <p className="mt-0.5 text-[10px] text-muted/70">
                  {stateLabel}
                  {state ? ` · ${t`${state.uniqueSessions} unique sessions`}` : ""}
                </p>
              </div>
            );
          })}
        </div>
      )}
      {showRemoteFolderPicker && remoteDesktopId ? (
        <RemoteHostFolderPicker
          desktopId={remoteDesktopId}
          title={t`Add usage history folder`}
          onClose={() => setShowRemoteFolderPicker(false)}
          onSelect={(path) => void addFolderPath(path)}
        />
      ) : null}
    </section>
  );
}
