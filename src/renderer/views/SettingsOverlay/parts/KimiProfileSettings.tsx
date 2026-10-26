import {
  extractKimiProfileInstanceId,
  kimiProfileKind,
  parseKimiProfileInstanceConfig,
} from "@/shared/contracts";
import {
  CliHomeProfileList,
  CliHomeProfileProviderSettings,
  createCliHomeProfileSupport,
  type CliHomeProfileDescriptor,
} from "./CliHomeProfileSettings";
import type { NativeAgentSettingsPanelProps } from "./agentRegistryNative";

const descriptor: CliHomeProfileDescriptor = {
  driver: "kimi",
  providerName: "Kimi",
  envVar: "KIMI_CODE_HOME",
  defaultHomeDir: (profileId) => `~/.poracode/kimi-profiles/${profileId}`,
  profileKind: kimiProfileKind,
  parseConfig: parseKimiProfileInstanceConfig,
};

export const kimiProfileSupport = createCliHomeProfileSupport(descriptor);

export function KimiAgentSettingsPanel(props: NativeAgentSettingsPanelProps) {
  const instanceId = extractKimiProfileInstanceId(props.agentKind);
  if (instanceId !== undefined) {
    return <CliHomeProfileProviderSettings descriptor={descriptor} instanceId={instanceId} />;
  }
  return (
    <CliHomeProfileList
      support={kimiProfileSupport}
      {...(props.onOpenProfile ? { onOpenProfile: props.onOpenProfile } : {})}
    />
  );
}
