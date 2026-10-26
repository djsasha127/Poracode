import { msg } from "@lingui/core/macro";
import { parseAntigravityProfileInstanceConfig } from "@/shared/contracts";
import type { RendererProviderManifest } from "../providerManifest";
import { formatTaskNotificationMarkdown } from "./taskNotificationMarkdown";

export default {
  kind: "antigravity",
  label: msg`Antigravity`,
  order: 50,
  profileUsageLabel: (instance) => {
    if (!parseAntigravityProfileInstanceConfig(instance.config).homeDir) return undefined;
    return `Antigravity ${instance.displayName ?? instance.id}`;
  },
  formatTranscriptMarkdown: formatTaskNotificationMarkdown,
} satisfies RendererProviderManifest;
