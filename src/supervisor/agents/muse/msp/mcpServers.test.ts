import { describe, expect, it } from "vitest";
import type { ResolvedMcpServer } from "@/shared/contracts";
import { buildMuseMcpServers, buildMuseSessionConfig } from "./mcpServers";

const base = { timeoutMs: 30_000 } as const;

describe("buildMuseMcpServers", () => {
  it("maps stdio and HTTP launch servers to Muse session config", () => {
    const servers: ResolvedMcpServer[] = [
      {
        ...base,
        id: "crossagents",
        name: "crossagents",
        transport: {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: { Authorization: "Bearer in-memory-token" },
        },
      },
      {
        ...base,
        id: "custom",
        name: "custom_tools",
        transport: {
          type: "stdio",
          command: "/usr/bin/node",
          args: ["server.mjs"],
          env: { TOOL_MODE: "safe" },
        },
      },
    ];

    expect(buildMuseSessionConfig(servers)).toEqual({
      mcpServers: {
        crossagents: {
          transport: "streamableHttp",
          url: "http://127.0.0.1:43123/mcp",
          headers: { Authorization: "Bearer in-memory-token" },
          mode: "required",
        },
        custom_tools: {
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["server.mjs"],
          env: { TOOL_MODE: "safe" },
          mode: "required",
        },
      },
    });
  });

  it("drops unsupported SSE servers without poisoning supported entries", () => {
    const servers: ResolvedMcpServer[] = [
      {
        ...base,
        id: "legacy",
        name: "legacy_sse",
        transport: { type: "sse", url: "https://example.com/sse", headers: {} },
      },
      {
        ...base,
        id: "stdio",
        name: "stdio_tools",
        transport: { type: "stdio", command: "tool", args: [], env: {} },
      },
    ];

    expect(buildMuseMcpServers(servers)).toEqual({
      stdio_tools: { transport: "stdio", command: "tool", mode: "required" },
    });
    expect(buildMuseSessionConfig([servers[0]!])).toBeUndefined();
  });
});
