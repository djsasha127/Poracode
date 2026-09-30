import type { ProjectLocation, ResolvedMcpServer, ThreadConfig } from "@/shared/contracts";

/**
 * Claude Code can attach its own Claude-in-Chrome bridge with `--chrome`.
 * Prefer Poracode's provider-neutral Chrome MCP when it resolved successfully;
 * fall back to the native bridge when a remote/headless host preserved the
 * thread opt-in but has no desktop-owned Chrome MCP endpoint to inject.
 */
export function shouldUseClaudeNativeChrome(
  location: Pick<ProjectLocation, "kind">,
  config: ThreadConfig,
  mcpServers: readonly ResolvedMcpServer[],
): boolean {
  return (
    location.kind !== "wsl" &&
    config.chromeMcp === true &&
    !mcpServers.some((server) => server.id === "chrome")
  );
}
