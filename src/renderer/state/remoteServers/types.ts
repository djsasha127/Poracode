import type {
  BrowseHostDirectoryResult,
  ProfileTokenStats,
  ProviderUsageResponse,
  Project,
  RemoteThreadCommand,
  Thread,
  TerminalSize,
} from "@/shared/contracts";
import type { RemoteDesktopClient, StartRemoteNewThreadInput } from "@/shared/remote/client";
import type {
  RemoteAccessScope,
  RemoteAgentStatuses,
  RemoteHostUpdateState,
  RemoteHostMode,
  RemoteImageRefValue,
  RemoteProjectCommand,
  RemoteShellSnapshot,
} from "@/shared/remote";
import type { SshConnectionConfig } from "@/shared/ssh";

/** Transport reachability is offline; reachable protocol or action failures are errors. */
export type RemoteServerStatus = "connecting" | "online" | "offline" | "error";

export interface RemoteServerRecord {
  readonly desktopId: string;
  readonly label: string;
  /** Host-reported label retained when `label` is overridden locally. */
  readonly remoteLabel?: string;
  readonly endpoint: string;
  readonly accessToken: string;
  readonly scopes: RemoteAccessScope[];
  /** Last version reported by the host environment descriptor. */
  readonly appVersion?: string;
  /** Absent on records paired before standalone helpers advertised their host mode. */
  readonly hostMode?: RemoteHostMode;
  /** Absent on records persisted before transport metadata existed. */
  readonly transport?:
    | { readonly kind: "direct" }
    | { readonly kind: "ssh"; readonly connection: SshConnectionConfig };
}

export interface RemoteServerRuntime {
  readonly status: RemoteServerStatus;
  readonly message?: string;
  readonly projects: RemoteShellSnapshot["projects"];
  readonly threads: RemoteShellSnapshot["threads"];
  readonly agentStatuses?: RemoteAgentStatuses;
  /** Usage collected by this host, kept separate from the local supervisor. */
  readonly providerUsage?: ProviderUsageResponse;
  /** Durable token and API-equivalent cost totals computed on this host. */
  readonly profileTokenStats?: ProfileTokenStats;
}

export interface OpenRemoteThread {
  readonly desktopId: string;
  readonly threadId: string;
  readonly thread: Thread;
  readonly terminalScrollback?: string;
  readonly terminalSize?: TerminalSize;
}

export type RemoteClientFactory = (endpoint: string, accessToken?: string) => RemoteDesktopClient;

export interface RemoteSocketLike {
  close(): void;
  send?(data: string): void;
  readonly readyState?: number;
  onopen?: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: { readonly code?: number; readonly reason?: string }) => void) | null;
}

export type RemoteSocketFactory = (url: string) => RemoteSocketLike;

export type RemoteThreadLaunchResult = "started" | "cancelled" | "cancellation-failed";

export interface RemoteServersState {
  servers: RemoteServerRecord[];
  runtime: Record<string, RemoteServerRuntime>;
  hostUpdates: Record<string, RemoteHostUpdateState>;
  /** Expected version while a remotely installed desktop update restarts its host. */
  hostUpdateRestarts: Record<string, string>;
  /**
   * Remote (server-side) project ids the user excluded from sync, keyed by
   * desktopId. Local-only state, so a project can be dropped from — or restored
   * to — the sidebar while its server is offline. See `projectSync.ts`.
   */
  excludedProjectIds: Record<string, readonly string[]>;
  /** Local workspace overrides for mirrored projects; null explicitly means unfiled. */
  projectWorkspaceIds: Record<string, Readonly<Record<string, string | null>>>;
  /** Local display-name overrides for mirrored projects, keyed by desktop and remote project id. */
  projectNameOverrides: Record<string, Readonly<Record<string, string>>>;
  /** Last discovered host projects, retained so offline servers keep their sidebar rows. */
  lastKnownProjects: Record<string, Project[]>;
  setProjectNameOverride(desktopId: string, remoteProjectId: string, name: string): void;
  setRemoteProjectSynced(desktopId: string, remoteProjectId: string, synced: boolean): void;
  clientFactory: RemoteClientFactory;
  socketFactory: RemoteSocketFactory;
  setClientFactory(factory: RemoteClientFactory): void;
  setSocketFactory(factory: RemoteSocketFactory): void;
  openThread: OpenRemoteThread | null;
  launchRemoteThread(
    input: StartRemoteNewThreadInput & { readonly desktopId: string },
    options?: { readonly isPendingLaunchOwned?: () => boolean },
  ): Promise<RemoteThreadLaunchResult>;
  /**
   * Hydrate a remote thread's history and, by default, focus it. Pass
   * `activate: false` when a pane layout already chose exactly where the
   * thread belongs (for example a sidebar drag-and-drop). Never rejects.
   */
  openRemoteThread(
    desktopId: string,
    threadId: string,
    options?: { readonly activate?: boolean },
  ): Promise<boolean>;
  closeRemoteThread(): void;
  sendThreadCommand(desktopId: string, command: RemoteThreadCommand): Promise<void>;
  pairServer(input: { endpoint: string; token: string }): Promise<RemoteServerRecord>;
  pairSshServer(connection: SshConnectionConfig): Promise<RemoteServerRecord>;
  renameServer(desktopId: string, label: string): void;
  removeServer(desktopId: string): void;
  refreshServer(
    desktopId: string,
    options?: { readonly includeAgentStatuses?: boolean },
  ): Promise<void>;
  /** Refresh usage for one remote host without affecting its connection state. */
  refreshProviderUsage(desktopId: string, providerIds?: readonly string[]): Promise<void>;
  /** Seal an API key on the remote host and refresh that provider. */
  setProviderUsageApiKey(desktopId: string, providerId: string, apiKey: string): Promise<void>;
  /** Refresh durable token/cost totals for one remote host. */
  refreshProfileTokenStats(desktopId: string): Promise<void>;
  scheduleServerRefresh(
    desktopId: string,
    options?: { readonly includeAgentStatuses?: boolean },
  ): void;
  connectAll(): Promise<void>;
  reconnectServer(desktopId: string): Promise<void>;
  getHostUpdateState(desktopId: string): ReturnType<RemoteDesktopClient["hostUpdateState"]>;
  checkHostUpdate(desktopId: string): ReturnType<RemoteDesktopClient["checkHostUpdate"]>;
  installHostUpdate(desktopId: string): Promise<void>;
  runProjectCommand(desktopId: string, command: RemoteProjectCommand): Promise<void>;
  loadProjectSettings(desktopId: string, projectId: string): Promise<void>;
  browseHostDirectory(desktopId: string, path: string): Promise<BrowseHostDirectoryResult>;
  withClient<Result>(
    desktopId: string,
    invoke: (client: RemoteDesktopClient) => Promise<Result>,
  ): Promise<Result>;
  saveClipboardImage(
    desktopId: string,
    input: { readonly threadId: string; readonly data: Uint8Array; readonly extension: string },
  ): Promise<string>;
  pickAndUploadFiles(desktopId: string, attachmentThreadId: string): Promise<string[] | null>;
  localImageUrl(desktopId: string, path: string): string;
  imageRefUrl(desktopId: string, ref: RemoteImageRefValue): string;
}

export function remoteServerStatusDotClass(status: RemoteServerStatus | undefined): string {
  return status === "online"
    ? "bg-success"
    : status === "connecting"
      ? "bg-warning"
      : status === "error"
        ? "bg-danger"
        : "bg-default-400";
}
