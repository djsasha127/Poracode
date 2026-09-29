import type { ResolvedMcpServer } from "@/shared/contracts";

export type MuseSessionMcpServerConfig =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      mode: "required";
    }
  | {
      transport: "streamableHttp";
      url: string;
      headers?: Record<string, string>;
      mode: "required";
    };

/**
 * Project Poracode's provider-neutral MCP launch snapshot into Muse MSP's
 * session-scoped configuration. Muse 1.4 accepts stdio and streamable HTTP;
 * legacy SSE has no MSP arm, so it stays unavailable instead of making the
 * entire Muse session fail schema validation.
 */
export function buildMuseMcpServers(
  servers: readonly ResolvedMcpServer[] | undefined,
): Record<string, MuseSessionMcpServerConfig> | undefined {
  if (!servers || servers.length === 0) return undefined;

  const result: Record<string, MuseSessionMcpServerConfig> = {};
  for (const server of servers) {
    const { transport } = server;
    if (transport.type === "stdio") {
      result[server.name] = {
        transport: "stdio",
        command: transport.command,
        ...(transport.args.length > 0 ? { args: [...transport.args] } : {}),
        ...(Object.keys(transport.env).length > 0 ? { env: { ...transport.env } } : {}),
        mode: "required",
      };
      continue;
    }
    if (transport.type === "http") {
      result[server.name] = {
        transport: "streamableHttp",
        url: transport.url,
        ...(Object.keys(transport.headers).length > 0 ? { headers: { ...transport.headers } } : {}),
        mode: "required",
      };
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function buildMuseSessionConfig(
  servers: readonly ResolvedMcpServer[] | undefined,
): { mcpServers: Record<string, MuseSessionMcpServerConfig> } | undefined {
  const mcpServers = buildMuseMcpServers(servers);
  return mcpServers ? { mcpServers } : undefined;
}
