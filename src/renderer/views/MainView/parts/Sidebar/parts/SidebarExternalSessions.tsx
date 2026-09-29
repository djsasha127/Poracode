import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Download } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import type { ImportableSession } from "@/shared/contracts";
import { readBridge } from "@/renderer/bridge";
import { SidebarButton } from "@/renderer/components/common/SidebarButton";
import { ProviderIcon } from "@/renderer/components/providers/ProviderIcon";
import {
  findImportedThreadId,
  importSessions,
} from "@/renderer/components/sessionImport/importSessionsActions";
import { openThread } from "@/renderer/actions/threadActions";
import { useAppStore } from "@/renderer/state/appStore";
import { usePanelStore } from "@/renderer/state/panelStore";

const SIDEBAR_SESSION_LIMIT = 5;

/**
 * A lightweight, read-only view over the provider transcript folders. A row is
 * turned into a normal Poracode thread only when the user opens it, keeping the
 * separate Nightly database small and leaving the original transcript alone.
 */
export function SidebarExternalSessions(props: { fallbackProjectId?: string }) {
  const { t } = useLingui();
  const [sessions, setSessions] = useState<ImportableSession[]>([]);
  const [busySessionId, setBusySessionId] = useState<string>();
  const [expanded, setExpanded] = useState(() => useAppStore.getState().threads.length <= 1);
  const threads = useAppStore((state) => state.threads);
  const openImportSettings = () => usePanelStore.getState().openSettingsSection("import");

  useEffect(() => {
    let cancelled = false;
    void readBridge()
      .listImportableSessions({ limit: SIDEBAR_SESSION_LIMIT })
      .then((result) => {
        if (!cancelled && !result.superseded) setSessions(result.sessions);
      })
      .catch(() => {
        // Discovery is an optional convenience. The full import dialog reports
        // actionable read errors when the user explicitly opens it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pending = useMemo(
    () => sessions.filter((session) => !findImportedThreadId(session, threads)),
    [sessions, threads],
  );
  const visible = pending.slice(0, SIDEBAR_SESSION_LIMIT);

  if (pending.length === 0) return null;

  const openSession = async (session: ImportableSession) => {
    if (!session.cwdExists && !props.fallbackProjectId) {
      openImportSettings();
      return;
    }

    setBusySessionId(session.id);
    try {
      const result = await importSessions({
        sessions: [session],
        ...(props.fallbackProjectId ? { fallbackProjectId: props.fallbackProjectId } : {}),
      });
      const threadId = result.threadIds.get(session.id);
      if (!threadId) return;
      openThread(threadId, { switchWorkspace: true });
    } finally {
      setBusySessionId(undefined);
    }
  };

  return (
    <section className="shrink-0 border-t border-[var(--hairline)] pt-1">
      <SidebarButton
        size="xs"
        density="compact"
        icon={
          <ChevronRight
            className={`size-3.5 shrink-0 text-muted transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
          />
        }
        label={t`Import sessions`}
        onPress={() => setExpanded((current) => !current)}
      />

      {expanded ? (
        <div className="space-y-0.5">
          {visible.map((session) => (
            <SidebarButton
              key={session.id}
              size="xs"
              density="compact"
              icon={<ProviderIcon kind={session.agentKind} tone="inactive" className="size-3.5" />}
              label={session.title ?? session.preview ?? session.providerSessionId}
              tooltip={
                <span className="flex flex-col gap-1">
                  <span>{session.title ?? session.preview ?? session.providerSessionId}</span>
                  {session.cwd ? (
                    <span className="font-mono text-[10px]">{session.cwd}</span>
                  ) : null}
                </span>
              }
              isDisabled={busySessionId !== undefined}
              onPress={() => void openSession(session)}
            />
          ))}
          {pending.length > SIDEBAR_SESSION_LIMIT ? (
            <SidebarButton
              size="xs"
              density="compact"
              icon={<Download className="size-3.5" />}
              label={t`Import sessions`}
              onPress={openImportSettings}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
