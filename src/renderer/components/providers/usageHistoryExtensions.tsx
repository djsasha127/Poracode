import type { ComponentType } from "react";

export interface UsageHistoryPanelExtensionProps {
  providerId: string;
  remoteServerId?: string;
  remoteSourceLabel?: string;
}

const panelExtensions = new Map<string, ComponentType<UsageHistoryPanelExtensionProps>>();
const settingsExtensions = new Map<string, ComponentType>();

export function registerUsageHistoryPanelExtension(
  providerId: string,
  component: ComponentType<UsageHistoryPanelExtensionProps>,
): void {
  panelExtensions.set(providerId, component);
}

export function registerUsageHistorySettingsExtension(
  providerId: string,
  component: ComponentType,
): void {
  settingsExtensions.set(providerId, component);
}

export function UsageHistoryPanelExtension(props: UsageHistoryPanelExtensionProps) {
  const Extension = panelExtensions.get(props.providerId);
  // The registry is populated during provider startup and remains stable while rendering.
  // oxlint-disable-next-line react/static-components
  return Extension ? <Extension {...props} /> : null;
}

export function UsageHistorySettingsExtensions() {
  return [...settingsExtensions.entries()].map(([providerId, Extension]) => (
    // The registry is populated during provider startup and remains stable while rendering.
    // oxlint-disable-next-line react/static-components
    <Extension key={providerId} />
  ));
}
