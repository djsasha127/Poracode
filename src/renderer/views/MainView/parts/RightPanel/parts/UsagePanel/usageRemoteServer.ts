interface UsageRemoteServerCandidate {
  readonly desktopId: string;
}

interface UsageRemoteRuntimeCandidate {
  readonly status: string;
}

/**
 * Usage is a global panel, so it must not lose remote history merely because
 * the currently open thread is local. Prefer the active thread's server when
 * it has one, otherwise use the first connected server.
 */
export function resolveUsageRemoteServerId(
  currentRemoteServerId: string | undefined,
  servers: readonly UsageRemoteServerCandidate[],
  runtime: Readonly<Record<string, UsageRemoteRuntimeCandidate | undefined>>,
): string | undefined {
  if (
    currentRemoteServerId &&
    servers.some((server) => server.desktopId === currentRemoteServerId)
  ) {
    return currentRemoteServerId;
  }
  return servers.find((server) => runtime[server.desktopId]?.status === "online")?.desktopId;
}
