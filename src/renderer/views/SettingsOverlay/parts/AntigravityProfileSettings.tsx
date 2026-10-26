import { Trans } from "@lingui/react/macro";
import {
  antigravityProfileKind,
  extractAntigravityProfileInstanceId,
  parseAntigravityProfileInstanceConfig,
} from "@/shared/contracts";
import {
  CliHomeProfileList,
  CliHomeProfileProviderSettings,
  createCliHomeProfileSupport,
  type CliHomeProfileDescriptor,
} from "./CliHomeProfileSettings";
import type { NativeAgentSettingsPanelProps } from "./agentRegistryNative";

const descriptor: CliHomeProfileDescriptor = {
  driver: "antigravity",
  providerName: "Antigravity",
  envVar: "HOME",
  defaultHomeDir: (profileId) => `~/.poracode/antigravity-profiles/${profileId}`,
  profileKind: antigravityProfileKind,
  parseConfig: parseAntigravityProfileInstanceConfig,
};

const baseProfileSupport = createCliHomeProfileSupport(descriptor);

export const antigravityProfileSupport = {
  ...baseProfileSupport,
  description: (
    <Trans>
      Run additional Antigravity CLI accounts from isolated homes. Each profile signs in separately
      and keeps its own conversations and quota. Chat remains on the main Antigravity account.
    </Trans>
  ),
};

export function AntigravityAgentSettingsPanel(props: NativeAgentSettingsPanelProps) {
  const instanceId = extractAntigravityProfileInstanceId(props.agentKind);
  if (instanceId !== undefined) {
    return <CliHomeProfileProviderSettings descriptor={descriptor} instanceId={instanceId} />;
  }
  return (
    <CliHomeProfileList
      support={antigravityProfileSupport}
      {...(props.onOpenProfile ? { onOpenProfile: props.onOpenProfile } : {})}
    />
  );
}
