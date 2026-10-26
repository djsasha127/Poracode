import { useState } from "react";
import { Button, toast } from "@heroui/react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentInstanceConfig, CliHomeProfileInstanceConfig } from "@/shared/contracts";
import { ConfirmDialog, Input } from "@/renderer/components/common";
import { readBridge } from "@/renderer/bridge";
import { useAppStore } from "@/renderer/state/appStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { currentWslDistros } from "@/renderer/utils/acpRegistryAuth";
import { AgentProfileList } from "./AgentProfileList";
import type { NativeAgentProfileSupport } from "./agentRegistryNative";

export interface CliHomeProfileDescriptor {
  driver: string;
  providerName: string;
  envVar: string;
  defaultHomeDir: (profileId: string) => string;
  profileKind: (profileId: string) => string;
  parseConfig: (value: unknown) => CliHomeProfileInstanceConfig;
}

function refreshProfile(kind: string): void {
  window.setTimeout(() => {
    void readBridge().refreshAgentStatuses(currentWslDistros(), { agentKinds: [kind] });
  }, 50);
}

export function CliHomeProfileProviderSettings(props: {
  descriptor: CliHomeProfileDescriptor;
  instanceId: string;
}) {
  const instance = useSharedSettings((state) => state.agentInstances[props.instanceId]);
  if (!instance || instance.driver !== props.descriptor.driver) return null;
  let config: CliHomeProfileInstanceConfig;
  try {
    config = props.descriptor.parseConfig(instance.config);
  } catch {
    return null;
  }
  return (
    <CliHomeProfileEditor
      key={instance.id}
      descriptor={props.descriptor}
      instance={instance}
      config={config}
    />
  );
}

function CliHomeProfileEditor(props: {
  descriptor: CliHomeProfileDescriptor;
  instance: AgentInstanceConfig;
  config: CliHomeProfileInstanceConfig;
}) {
  const { t } = useLingui();
  const setAgentInstance = useSharedSettings((state) => state.setAgentInstance);
  const profileKind = props.descriptor.profileKind(props.instance.id);
  const hasThreads = useAppStore((state) =>
    state.threads.some((thread) => thread.agentKind === profileKind),
  );
  const [name, setName] = useState(props.instance.displayName ?? props.instance.id);
  const [homeDir, setHomeDir] = useState(props.config.homeDir);
  const [confirmHomeChange, setConfirmHomeChange] = useState(false);

  const trimmedName = name.trim();
  const trimmedHomeDir = homeDir.trim();
  const dirty =
    trimmedName !== (props.instance.displayName ?? props.instance.id) ||
    trimmedHomeDir !== props.config.homeDir;
  const canSave = trimmedName.length > 0 && trimmedHomeDir.length > 0 && dirty;
  const strandsThreads = hasThreads && trimmedHomeDir !== props.config.homeDir;

  const commit = () => {
    if (!canSave) return;
    setAgentInstance({
      ...props.instance,
      displayName: trimmedName,
      config: { homeDir: trimmedHomeDir },
    });
    refreshProfile(profileKind);
    toast.success(t`${props.descriptor.providerName} profile saved.`);
  };

  const save = () => {
    if (!canSave) return;
    if (strandsThreads) {
      setConfirmHomeChange(true);
      return;
    }
    commit();
  };

  const warning = (
    <Trans>
      This profile already has threads. Their sessions stay in the current home directory, so they
      can't be resumed after you change it.
    </Trans>
  );

  return (
    <div className="space-y-4 border-t border-border/10 pt-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            <Trans>Profile home</Trans>
          </p>
          <p className="text-xs text-muted">
            <Trans>
              {props.descriptor.providerName} runs this profile with {props.descriptor.envVar} set
              to the directory below. Use Login above to sign this profile in to its own account.
            </Trans>
          </p>
        </div>
        <Button size="sm" variant="tertiary" isDisabled={!canSave} onPress={save}>
          <Trans>Save</Trans>
        </Button>
      </div>
      <section className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted">
            <Trans>Name</Trans>
          </span>
          <Input
            aria-label={t`Profile name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted">
            <Trans>Home directory</Trans>
          </span>
          <Input
            aria-label={t`Profile home directory`}
            className="font-mono text-xs"
            value={homeDir}
            onChange={(event) => setHomeDir(event.target.value)}
          />
        </div>
      </section>
      {strandsThreads ? <p className="text-xs text-warning">{warning}</p> : null}
      <ConfirmDialog
        isOpen={confirmHomeChange}
        title={t`Change profile home?`}
        body={warning}
        confirmLabel={t`Change home`}
        confirmVariant="primary"
        status="warning"
        onConfirm={() => {
          setConfirmHomeChange(false);
          commit();
        }}
        onClose={() => setConfirmHomeChange(false)}
      />
    </div>
  );
}

export function createCliHomeProfileSupport(
  descriptor: CliHomeProfileDescriptor,
): NativeAgentProfileSupport {
  function RowSubtitle({ instance }: { instance: AgentInstanceConfig }) {
    let homeDir = instance.id;
    try {
      homeDir = descriptor.parseConfig(instance.config).homeDir;
    } catch {
      // Keep the malformed record visible so it can be removed.
    }
    return <span className="truncate font-mono">{homeDir}</span>;
  }

  return {
    driver: descriptor.driver,
    description: (
      <Trans>
        Run additional {descriptor.providerName} accounts from isolated home directories. Each
        profile signs in separately.
      </Trans>
    ),
    field: {
      ariaLabel: msg`New profile home directory`,
      placeholderFor: (_name, id) => descriptor.defaultHomeDir(id),
    },
    RowSubtitle,
    removalBody: (profileName) => (
      <Trans>
        Removing {profileName} drops it from Poracode. Its home directory and credentials stay on
        disk.
      </Trans>
    ),
    createPayload: ({ id, displayName, field }) => ({
      driver: descriptor.driver,
      id,
      displayName,
      config: { homeDir: field },
    }),
  };
}

export function CliHomeProfileList(props: {
  support: NativeAgentProfileSupport;
  onOpenProfile?: (profileKind: string) => void;
}) {
  return <AgentProfileList profiles={props.support} onOpenProfile={props.onOpenProfile} />;
}
