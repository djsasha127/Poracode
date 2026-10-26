import { Server, Workflow } from "lucide-react";
import { startTransition, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { useCurrentProjectId } from "@/renderer/hooks/uiSelectors";
import { useAppStore } from "@/renderer/state/appStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";

export interface SidebarShortcutEntry {
  id: "pullRequests" | "githubActions" | "schedules";
  icon: ReactNode;
  label: string;
  isActive: boolean;
  onPress: () => void;
}

/**
 * The configurable sidebar destinations (Settings → General can hide or
 * reorder them). Shared by the expanded footer nav and the collapsed icon
 * rail so both surfaces resolve order, visibility, and active state the same
 * way.
 */
export function useSidebarShortcuts(): SidebarShortcutEntry[] {
  const { t } = useLingui();
  const currentProjectId = useCurrentProjectId();
  const sidebarHiddenShortcuts = useSharedSettings((s) => s.sidebarHiddenShortcuts);
  const sidebarShortcutOrder = useSharedSettings((s) => s.sidebarShortcutOrder);
  const appView = useAppStore((s) => s.view);
  const openGitHubActions = useAppStore((s) => s.openGitHubActions);
  const settingsOpen = usePanelStore((s) => s.settingsOpen);
  const settingsSection = usePanelStore((s) => s.settingsSection);
  const openSettingsSection = usePanelStore((s) => s.openSettingsSection);
  const githubActionsOpen = usePanelStore((s) => s.githubActionsContext !== null);

  const sidebarShortcutsById = new Map<
    SidebarShortcutEntry["id"],
    Omit<SidebarShortcutEntry, "isActive">
  >([
    [
      "githubActions",
      {
        id: "githubActions",
        icon: <Workflow className="size-4" />,
        label: t`GitHub Actions`,
        onPress: () => startTransition(() => openGitHubActions(currentProjectId)),
      },
    ],
    [
      "schedules",
      {
        id: "schedules",
        icon: <Server className="size-4" />,
        label: t`Remote Environments`,
        onPress: () => startTransition(() => openSettingsSection("remoteServers")),
      },
    ],
  ]);

  return sidebarShortcutOrder
    .map((id) => sidebarShortcutsById.get(id))
    .filter(
      (shortcut): shortcut is NonNullable<typeof shortcut> =>
        shortcut !== undefined && !sidebarHiddenShortcuts.includes(shortcut.id),
    )
    .map((shortcut) => ({
      ...shortcut,
      isActive:
        shortcut.id === "githubActions"
          ? githubActionsOpen
          : shortcut.id === "schedules"
            ? settingsOpen && settingsSection === "remoteServers"
            : appView.kind === shortcut.id,
    }));
}
