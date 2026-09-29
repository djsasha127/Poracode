import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectLocation, RuntimeEvent, ThreadConfig } from "@/shared/contracts";
import type { CreateStructuredSessionInput, StructuredSessionUpdate } from "../../base";

const request = vi.hoisted(() =>
  vi.fn<(method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
);
const initialize = vi.hoisted(() =>
  vi
    .fn<
      (
        clientName?: string,
        clientVersion?: string,
        requestedCapabilities?: readonly string[],
      ) => Promise<{
        schema: { version: number; fingerprint: string };
        grantedCapabilities: string[];
      }>
    >()
    .mockResolvedValue({
      schema: { version: 1, fingerprint: "fixture" },
      grantedCapabilities: ["sessionMcp"],
    }),
);
const disposeClient = vi.hoisted(() => vi.fn<() => void>());
const terminate = vi.hoisted(() =>
  vi.fn<(child: EventEmitter, options: { ownedProcessGroup: boolean }) => void>(),
);
const spawnMuseServeHost = vi.hoisted(() =>
  vi.fn<
    () => Promise<{ child: EventEmitter; transport: Record<string, never>; hostCookie: string }>
  >(),
);
let notificationHandler: ((method: string, params: Record<string, unknown>) => void) | undefined;
let clientErrorHandler: ((error: Error) => void) | undefined;
let serverRequestHandler:
  | ((request: {
      id: number;
      method: string;
      params: Record<string, unknown>;
    }) => Record<string, unknown>)
  | undefined;

vi.mock("@/shared/processTree", () => ({ terminateChildProcessTree: terminate }));
vi.mock("./client", () => ({
  spawnMuseServeHost,
  MuseMspClient: class {
    initialize = initialize;
    request = request;
    dispose = disposeClient;
    onNotification(handler: (method: string, params: Record<string, unknown>) => void) {
      notificationHandler = handler;
    }
    onError(handler: (error: Error) => void) {
      clientErrorHandler = handler;
    }
    onServerRequest(
      handler: (request: {
        id: number;
        method: string;
        params: Record<string, unknown>;
      }) => Record<string, unknown>,
    ) {
      serverRequestHandler = handler;
    }
  },
}));

import { MuseMspStructuredSession } from "./session";
import { MspRpcError } from "./protocol";

const projectLocation: ProjectLocation = {
  kind: "wsl",
  distro: "Ubuntu",
  linuxPath: "/mnt/c/project",
  uncPath: "\\\\wsl.localhost\\Ubuntu\\mnt\\c\\project",
};
const config: ThreadConfig = {
  model: "muse-spark-1.3",
  effort: "high",
  approvalPolicy: "on-request",
};

function input(
  overrides: Partial<CreateStructuredSessionInput> = {},
): CreateStructuredSessionInput {
  return {
    threadId: "thread-1",
    projectLocation,
    config,
    presentationMode: "gui",
    ...overrides,
  };
}

function sessionRecord(sessionId = "session-1"): Record<string, unknown> {
  return { sessionId, activeTurnId: null, status: "idle" };
}

async function createSession(overrides: Partial<CreateStructuredSessionInput> = {}) {
  const runtimeEvents: RuntimeEvent[] = [];
  const updates: StructuredSessionUpdate[] = [];
  const errors: string[] = [];
  const closes: string[] = [];
  const child = new EventEmitter();
  spawnMuseServeHost.mockResolvedValue({
    child,
    transport: {},
    hostCookie: "test-host-cookie",
  });
  request.mockImplementation(async (method) => {
    if (method === "session/start" || method === "session/resume") {
      return { session: sessionRecord() };
    }
    if (method === "turn/start") {
      return { turnId: "turn-1", status: "accepted", disposition: "started" };
    }
    return { status: "accepted" };
  });
  const session = await MuseMspStructuredSession.create(input(overrides));
  session.setListener({
    onClose() {
      closes.push("close");
    },
    onError(message) {
      errors.push(message);
    },
    onUpdate(update) {
      updates.push(update);
    },
    onRuntimeEvent(event) {
      runtimeEvents.push(event);
    },
  });
  await session.activate();
  return { session, child, runtimeEvents, updates, errors, closes };
}

beforeEach(() => {
  vi.clearAllMocks();
  initialize.mockResolvedValue({
    schema: { version: 1, fingerprint: "fixture" },
    grantedCapabilities: ["sessionMcp"],
  });
  notificationHandler = undefined;
  clientErrorHandler = undefined;
  serverRequestHandler = undefined;
});

describe("MuseMspStructuredSession", () => {
  it("routes session/start through the catalog's provider for the model", async () => {
    // `session/start` without `providerId` falls back to the server default,
    // whose retained-history policy rejects media — unlike the catalog route
    // the CLI uses.
    const { session } = await createSession();
    request.mockImplementation(async (method) => {
      if (method === "model/list") {
        return {
          models: [
            {
              modelId: "muse-spark-1.3",
              displayLabel: "Muse Spark 1.3",
              providerId: "meta",
              isDefault: true,
              isActive: true,
              contextLimit: 1_000_000,
            },
          ],
          providerId: "meta",
          source: "bundledCatalog",
        };
      }
      if (method === "session/start" || method === "session/resume") {
        return { session: sessionRecord() };
      }
      return { status: "accepted" };
    });
    await session.openThread(config);
    const start = request.mock.calls.find(([method]) => method === "session/start");
    expect(start?.[1]).toMatchObject({ modelId: "muse-spark-1.3", providerId: "meta" });
  });

  it("omits providerId when the catalog lists the model without one, keeping the server default", async () => {
    const { session } = await createSession();
    await session.openThread(config);
    const start = request.mock.calls.find(([method]) => method === "session/start");
    expect(start?.[1]).not.toHaveProperty("providerId");
  });

  it("omits providerId when the model/list lookup fails, keeping the server default", async () => {
    const { session } = await createSession();
    request.mockImplementation(async (method) => {
      if (method === "model/list") throw new Error("model/list unavailable");
      if (method === "session/start" || method === "session/resume") {
        return { session: sessionRecord() };
      }
      return { status: "accepted" };
    });
    await session.openThread(config);
    const start = request.mock.calls.find(([method]) => method === "session/start");
    expect(start?.[1]).not.toHaveProperty("providerId");
  });

  it("starts a durable GUI session and streams a turn", async () => {
    const { session, runtimeEvents, updates } = await createSession();
    await expect(session.openThread(config)).resolves.toBe("session-1");
    expect(request).toHaveBeenCalledWith(
      "session/start",
      expect.objectContaining({
        workspaceRoot: "/mnt/c/project",
        modelId: "muse-spark-1.3",
        approvalMode: "onRequest",
      }),
    );

    await session.startTurn("hello", config, undefined, { userMessageItemId: "user-1" });
    const turnStart = request.mock.calls.find(([method]) => method === "turn/start");
    const commandId = turnStart?.[1]?.["commandId"];
    notificationHandler?.("item/completed", {
      sessionId: "session-1",
      item: {
        itemId: "provider-user-1",
        commandId,
        kind: "userMessage",
        status: "completed",
        text: "hello",
      },
    });
    notificationHandler?.("item/started", {
      sessionId: "session-1",
      item: { itemId: "assistant-1", kind: "agentMessage", status: "inProgress", text: "" },
    });
    notificationHandler?.("item/delta", {
      sessionId: "session-1",
      itemId: "assistant-1",
      field: "text",
      delta: "hello back",
    });
    notificationHandler?.("item/completed", {
      sessionId: "session-1",
      item: {
        itemId: "assistant-1",
        kind: "agentMessage",
        status: "completed",
        text: "hello back",
      },
    });
    notificationHandler?.("turn/completed", {
      sessionId: "session-1",
      turnId: "turn-1",
      terminal: "completed",
    });

    expect(runtimeEvents).toContainEqual({
      type: "content.delta",
      threadId: "thread-1",
      itemId: "assistant-1",
      stream: "assistant_text",
      delta: "hello back",
    });
    expect(
      runtimeEvents.filter(
        (event) => event.type === "item.started" && event.itemType === "user_message",
      ),
    ).toHaveLength(0);
    expect(runtimeEvents).toContainEqual({
      type: "turn.completed",
      threadId: "thread-1",
      turnId: "turn-1",
      state: "completed",
    });
    expect(updates.at(-1)).toMatchObject({
      status: "idle",
      sessionRef: { providerSessionId: "session-1" },
    });
  });

  it("passes enabled MCP servers into the Muse session", async () => {
    const { session } = await createSession({
      mcpServers: [
        {
          id: "crossagents",
          name: "crossagents",
          timeoutMs: 30_000,
          transport: {
            type: "http",
            url: "http://127.0.0.1:43123/mcp",
            headers: { Authorization: "Bearer test-token" },
          },
        },
      ],
    });

    await session.openThread(config);

    expect(initialize).toHaveBeenCalledWith("poracode", "1.0.0", ["sessionMcp"]);

    expect(request).toHaveBeenCalledWith(
      "session/start",
      expect.objectContaining({
        config: {
          mcpServers: {
            crossagents: {
              transport: "streamableHttp",
              url: "http://127.0.0.1:43123/mcp",
              headers: { Authorization: "Bearer test-token" },
              mode: "required",
            },
          },
        },
      }),
    );
  });

  it("falls back to Muse's sealed approval ceiling without dropping session MCP", async () => {
    const { session } = await createSession({
      config: { ...config, approvalPolicy: "yolo" },
      mcpServers: [
        {
          id: "crossagents",
          name: "crossagents",
          timeoutMs: 30_000,
          transport: { type: "http", url: "http://127.0.0.1:43123/mcp", headers: {} },
        },
      ],
    });
    let starts = 0;
    request.mockImplementation(async (method) => {
      if (method === "session/start" && starts++ === 0) {
        throw new MspRpcError("approval mode exceeds sealed startup mode", {
          code: -32_052,
          kind: "commandRejected",
          data: { reason: "approval_mode_ceiling" },
        });
      }
      if (method === "session/start") return { session: sessionRecord() };
      return { status: "accepted" };
    });

    await expect(session.openThread({ ...config, approvalPolicy: "yolo" })).resolves.toBe(
      "session-1",
    );
    const startsParams = request.mock.calls
      .filter(([method]) => method === "session/start")
      .map(([, params]) => params);
    expect(startsParams).toHaveLength(2);
    expect(startsParams[0]).toMatchObject({ approvalMode: "allowAll" });
    expect(startsParams[1]).toMatchObject({
      approvalMode: "promptUnmatched",
      config: { mcpServers: { crossagents: expect.anything() } },
    });
  });

  it("omits session MCP config when the host does not grant the capability", async () => {
    initialize.mockResolvedValue({
      schema: { version: 1, fingerprint: "fixture" },
      grantedCapabilities: [],
    });
    const { session } = await createSession({
      mcpServers: [
        {
          id: "crossagents",
          name: "crossagents",
          timeoutMs: 30_000,
          transport: { type: "http", url: "http://127.0.0.1:43123/mcp", headers: {} },
        },
      ],
    });

    await session.openThread(config);

    const start = request.mock.calls.find(([method]) => method === "session/start");
    expect(start?.[1]).not.toHaveProperty("config");
  });

  it("reattaches an idle-unloaded session and retries the same turn", async () => {
    const { session, errors } = await createSession({
      sessionRef: { providerSessionId: "session-1", discoveredAt: "test" },
    });
    let turnAttempts = 0;
    request.mockImplementation(async (method) => {
      if (method === "session/resume") {
        return { session: sessionRecord(), viewCursor: "v:session-1:2" };
      }
      if (method === "turn/start") {
        turnAttempts += 1;
        if (turnAttempts === 1) {
          throw new Error("session session-1 is not loaded on this host");
        }
        return { turnId: "turn-after-resume", disposition: "started" };
      }
      return { status: "accepted" };
    });

    await session.openThread(config);
    request.mockClear();
    await expect(session.startTurn("continue", config)).resolves.toBeUndefined();

    const calls = request.mock.calls;
    expect(calls.filter(([method]) => method === "turn/start")).toHaveLength(2);
    expect(calls.filter(([method]) => method === "session/resume")).toHaveLength(1);
    const turnCommands = calls
      .filter(([method]) => method === "turn/start")
      .map(([, params]) => params?.["commandId"]);
    expect(new Set(turnCommands).size).toBe(1);
    expect(errors).toEqual([]);
  });

  it("rotates corrupted compacted history and retries a duplicate tool-output turn once", async () => {
    const { session, runtimeEvents, updates, errors } = await createSession();
    let sessionStarts = 0;
    let turnStarts = 0;
    request.mockImplementation(async (method, params) => {
      if (method === "session/start") {
        sessionStarts += 1;
        return {
          session: sessionRecord(sessionStarts === 1 ? "session-broken" : "session-fresh"),
        };
      }
      if (method === "turn/start") {
        turnStarts += 1;
        return {
          turnId: turnStarts === 1 ? "turn-broken" : "turn-retried",
          disposition: "started",
        };
      }
      if (method === "view/page") return { events: [] };
      return { status: "accepted", params };
    });

    await session.openThread(config);
    await session.startTurn("continue after compaction", config, undefined, {
      userMessageItemId: "user-once",
    });
    notificationHandler?.("turn/completed", {
      sessionId: "session-broken",
      turnId: "turn-broken",
      terminal: "failed",
      error: {
        message:
          "Duplicate function_call_output for call_id 'call-1'. Each function_call must have exactly one matching function_call_output",
      },
    });

    await vi.waitFor(() => expect(turnStarts).toBe(2));
    const retried = request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1];
    expect(retried).toMatchObject({
      sessionId: "session-fresh",
      displayText: "continue after compaction",
    });
    expect(updates.at(-1)).toMatchObject({
      status: "working",
      sessionRef: { providerSessionId: "session-fresh" },
    });
    expect(errors).toEqual([]);
    expect(runtimeEvents).not.toContainEqual(
      expect.objectContaining({ type: "error", message: expect.stringContaining("Duplicate") }),
    );

    notificationHandler?.("turn/completed", {
      sessionId: "session-fresh",
      turnId: "turn-retried",
      terminal: "completed",
    });
    expect(runtimeEvents).toContainEqual({
      type: "turn.completed",
      threadId: "thread-1",
      turnId: "turn-retried",
      state: "completed",
    });
  });

  it("settles a failed history recovery once without a synthetic replacement turn", async () => {
    const { session, runtimeEvents } = await createSession();
    let sessionStarts = 0;
    request.mockImplementation(async (method) => {
      if (method === "session/start") {
        sessionStarts += 1;
        if (sessionStarts === 1) return { session: sessionRecord("session-broken") };
        throw new Error("replacement session unavailable");
      }
      if (method === "turn/start") {
        return { turnId: "turn-broken", disposition: "started" };
      }
      return { status: "accepted" };
    });

    await session.openThread(config);
    await session.startTurn("continue after compaction", config);
    notificationHandler?.("turn/completed", {
      sessionId: "session-broken",
      turnId: "turn-broken",
      terminal: "failed",
      error: {
        message:
          "Duplicate function_call_output for call_id 'call-1'. Each function_call must have exactly one matching function_call_output",
      },
    });

    await vi.waitFor(() =>
      expect(runtimeEvents.filter((event) => event.type === "turn.completed")).toContainEqual({
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-broken",
        state: "failed",
      }),
    );
    expect(runtimeEvents.filter((event) => event.type === "error")).toHaveLength(1);
    expect(
      runtimeEvents.filter(
        (event) => event.type === "turn.completed" && event.turnId !== "turn-broken",
      ),
    ).toEqual([]);
  });

  it("resumes only the supplied Poracode session without replaying history", async () => {
    const { session } = await createSession({
      sessionRef: { providerSessionId: "session-1", discoveredAt: "2026-01-01T00:00:00Z" },
    });
    await session.openThread(config);
    expect(request).toHaveBeenCalledWith(
      "session/resume",
      expect.objectContaining({ sessionId: "session-1", excludeItems: true }),
    );
  });

  it("replays only the durable suffix after a persisted provider cursor", async () => {
    const { session, runtimeEvents } = await createSession({
      sessionRef: {
        providerSessionId: "session-1",
        discoveredAt: "2026-01-01T00:00:00Z",
        providerCursor: "cursor-persisted",
      },
    });
    request.mockImplementation(async (method, params) => {
      if (method === "session/resume") {
        return { session: sessionRecord(), viewCursor: "" };
      }
      if (method === "view/page") {
        if (params?.["direction"] === "backward") {
          return {
            events: [
              {
                method: "turn/completed",
                params: {
                  sessionId: "session-1",
                  viewCursor: "cursor-current-head",
                  turnId: "turn-after-restart",
                  terminal: "completed",
                },
              },
            ],
            nextCursor: "cursor-current-head",
          };
        }
        return {
          events: [
            {
              method: "item/completed",
              params: {
                sessionId: "session-1",
                viewCursor: "cursor-answer",
                item: {
                  itemId: "assistant-after-restart",
                  kind: "assistantMessage",
                  status: "completed",
                  text: "Recovered after restart",
                },
              },
            },
            {
              method: "turn/completed",
              params: {
                sessionId: "session-1",
                viewCursor: "cursor-current-head",
                turnId: "turn-after-restart",
                terminal: "completed",
              },
            },
          ],
          nextCursor: null,
        };
      }
      return { status: "accepted" };
    });

    await session.openThread(config);

    expect(request).toHaveBeenCalledWith("view/page", {
      sessionId: "session-1",
      direction: "backward",
      limit: 1,
    });
    expect(request).toHaveBeenCalledWith("view/page", {
      sessionId: "session-1",
      cursor: "cursor-persisted",
      direction: "forward",
      limit: 1_000,
    });
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "item.started",
        itemId: "assistant-after-restart",
        itemType: "assistant_message",
      }),
    );
    expect(runtimeEvents).toContainEqual({
      type: "turn.completed",
      threadId: "thread-1",
      turnId: "turn-after-restart",
      state: "completed",
    });
  });

  it("fills a dropped Muse view range before applying later live notifications", async () => {
    const { session, runtimeEvents, updates } = await createSession();
    request.mockImplementation(async (method) => {
      if (method === "session/start") return { session: sessionRecord() };
      if (method === "turn/start") {
        return { turnId: "turn-1", status: "accepted", disposition: "started" };
      }
      if (method === "view/page") {
        return {
          events: [
            {
              method: "item/completed",
              params: {
                sessionId: "session-1",
                viewCursor: "cursor-assistant",
                item: {
                  itemId: "assistant-1",
                  kind: "assistantMessage",
                  status: "completed",
                  text: "Recovered answer",
                },
              },
            },
            {
              method: "turn/completed",
              params: {
                sessionId: "session-1",
                viewCursor: "cursor-terminal",
                turnId: "turn-1",
                terminal: "completed",
              },
            },
            {
              method: "session/tokenUsage",
              params: {
                sessionId: "session-1",
                viewCursor: "cursor-live",
                cumulative: { totalTokens: 42 },
              },
            },
          ],
          nextCursor: null,
        };
      }
      return { status: "accepted" };
    });

    await session.openThread(config);
    await session.startTurn("hello", config);
    notificationHandler?.("view/gap", {
      sessionId: "session-1",
      after: "cursor-before-gap",
      next: "cursor-live",
    });
    notificationHandler?.("session/tokenUsage", {
      sessionId: "session-1",
      viewCursor: "cursor-live",
      cumulative: { totalTokens: 42 },
    });

    await vi.waitFor(() => {
      expect(runtimeEvents).toContainEqual(
        expect.objectContaining({
          type: "item.started",
          itemId: "assistant-1",
          itemType: "assistant_message",
        }),
      );
      expect(runtimeEvents).toContainEqual({
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "completed",
      });
      expect(runtimeEvents).toContainEqual(
        expect.objectContaining({
          type: "usage.spent",
          usage: expect.objectContaining({ counter: 42 }),
        }),
      );
    });
    expect(updates.at(-1)).toMatchObject({ status: "idle", attention: "none" });
    expect(request).toHaveBeenCalledWith("view/page", {
      sessionId: "session-1",
      cursor: "cursor-before-gap",
      direction: "forward",
      limit: 1_000,
    });
  });

  it("recovers a dropped terminal tail even when no later push reports a gap", async () => {
    vi.useFakeTimers();
    try {
      const { session, runtimeEvents, updates } = await createSession();
      request.mockImplementation(async (method) => {
        if (method === "session/start") {
          return { session: sessionRecord(), viewCursor: "cursor-before-turn" };
        }
        if (method === "turn/start") {
          return { turnId: "turn-1", status: "accepted", disposition: "started" };
        }
        if (method === "session/read") {
          return { viewCursor: "cursor-terminal" };
        }
        if (method === "view/page") {
          return {
            events: [
              {
                method: "item/completed",
                params: {
                  sessionId: "session-1",
                  viewCursor: "cursor-assistant",
                  item: {
                    itemId: "assistant-tail",
                    kind: "assistantMessage",
                    status: "completed",
                    text: "Recovered final answer",
                  },
                },
              },
              {
                method: "turn/completed",
                params: {
                  sessionId: "session-1",
                  viewCursor: "cursor-terminal",
                  turnId: "turn-1",
                  terminal: "completed",
                },
              },
            ],
            nextCursor: null,
          };
        }
        return { status: "accepted" };
      });

      await session.openThread(config);
      await session.startTurn("hello", config);
      await vi.advanceTimersByTimeAsync(2_100);

      expect(runtimeEvents).toContainEqual(
        expect.objectContaining({
          type: "item.started",
          itemId: "assistant-tail",
          itemType: "assistant_message",
        }),
      );
      expect(runtimeEvents).toContainEqual({
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "completed",
      });
      expect(updates.at(-1)).toMatchObject({ status: "idle", attention: "none" });
      await session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a historical failed turn from replacing the live turn during tail recovery", async () => {
    vi.useFakeTimers();
    try {
      const { session, runtimeEvents, updates } = await createSession();
      request.mockImplementation(async (method) => {
        if (method === "session/start") {
          return { session: sessionRecord(), viewCursor: "cursor-before-turn" };
        }
        if (method === "turn/start") {
          return { turnId: "turn-1", disposition: "started" };
        }
        if (method === "session/read") {
          return { session: sessionRecord(), viewCursor: "cursor-answer" };
        }
        if (method === "view/page") {
          return {
            events: [
              {
                method: "turn/started",
                params: {
                  sessionId: "session-1",
                  viewCursor: "cursor-old-start",
                  turnId: "turn-old",
                },
              },
              {
                method: "turn/completed",
                params: {
                  sessionId: "session-1",
                  viewCursor: "cursor-old-failure",
                  turnId: "turn-old",
                  terminal: "failed",
                  reason: "incomplete",
                },
              },
              {
                method: "item/completed",
                params: {
                  sessionId: "session-1",
                  viewCursor: "cursor-assistant",
                  item: {
                    itemId: "assistant-after-incomplete-ack",
                    kind: "assistantMessage",
                    status: "completed",
                    text: "SESSION_OK",
                  },
                },
              },
              {
                method: "turn/completed",
                params: {
                  sessionId: "session-1",
                  viewCursor: "cursor-answer",
                  turnId: "turn-1",
                  terminal: "completed",
                },
              },
            ],
            nextCursor: null,
          };
        }
        return { status: "accepted" };
      });

      await session.openThread(config);
      await session.startTurn("hello", config);
      await vi.advanceTimersByTimeAsync(2_100);

      expect(runtimeEvents).toContainEqual(
        expect.objectContaining({
          type: "item.started",
          itemId: "assistant-after-incomplete-ack",
        }),
      );
      expect(runtimeEvents).toContainEqual({
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "completed",
      });
      expect(runtimeEvents).not.toContainEqual(
        expect.objectContaining({ type: "error", message: "incomplete" }),
      );
      expect(updates.at(-1)).toMatchObject({
        status: "idle",
        attention: "none",
        sessionRef: { providerCursor: "cursor-answer" },
      });
      await session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("acknowledges re-issued server requests and restores resumed active turns", async () => {
    const { session, runtimeEvents, updates } = await createSession({
      sessionRef: { providerSessionId: "session-1", discoveredAt: "2026-01-01T00:00:00Z" },
    });
    request.mockImplementation(async (method) => {
      if (method === "session/resume") {
        return { session: { sessionId: "session-1", activeTurnId: "turn-resumed" } };
      }
      return { status: "accepted" };
    });
    await session.openThread(config);
    expect(
      serverRequestHandler?.({
        id: 18,
        method: "userInput/request",
        params: {
          sessionId: "session-1",
          userInputId: "input-resumed",
          questions: [
            {
              id: "database",
              header: "Database",
              question: "Choose a database",
              selection: { mode: "single" },
              options: [{ label: "Postgres" }],
            },
          ],
        },
      }),
    ).toEqual({});
    expect(runtimeEvents).toContainEqual({
      type: "turn.started",
      threadId: "thread-1",
      turnId: "turn-resumed",
    });
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({ type: "request.opened", requestId: "input-resumed" }),
    );
    expect(updates.at(-1)).toMatchObject({ status: "needs_reply", attention: "needs_reply" });
  });

  it("preserves re-issued request attention when it arrives with the resume response", async () => {
    const { session, updates } = await createSession({
      sessionRef: { providerSessionId: "session-1", discoveredAt: "2026-01-01T00:00:00Z" },
    });
    request.mockImplementation(async (method) => {
      if (method === "session/resume") {
        serverRequestHandler?.({
          id: 18,
          method: "userInput/request",
          params: {
            sessionId: "session-1",
            userInputId: "input-resumed",
            questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
          },
        });
        return { session: { sessionId: "session-1", activeTurnId: "turn-resumed" } };
      }
      return { status: "accepted" };
    });

    await session.openThread(config);

    expect(updates.at(-1)).toMatchObject({ status: "needs_reply", attention: "needs_reply" });
  });

  it("applies model and approval changes before the next turn", async () => {
    const { session } = await createSession();
    request.mockImplementation(async (method) => {
      if (method === "session/start") return { session: sessionRecord() };
      if (method === "turn/start") {
        return { turnId: "turn-1", status: "accepted", disposition: "started" };
      }
      return method === "model/list"
        ? {
            models: [
              {
                modelId: "muse-spark-1.3-contributor",
                displayLabel: "Muse Spark 1.3 Contributor",
                providerId: "meta",
              },
            ],
            providerId: "meta",
            profileId: "tbh",
          }
        : { status: "accepted" };
    });
    await session.openThread(config);
    await session.startTurn("next", {
      ...config,
      model: "muse-spark-1.3-contributor",
      approvalPolicy: "never",
    });
    expect(request).toHaveBeenCalledWith(
      "session/setModel",
      expect.objectContaining({
        model: {
          modelId: "muse-spark-1.3-contributor",
          providerId: "meta",
          profileId: "tbh",
        },
      }),
    );
    expect(request).toHaveBeenCalledWith(
      "session/setApprovalMode",
      expect.objectContaining({ mode: "allowAll" }),
    );
  });

  it("reconciles requested configuration when a resumed Muse session differs", async () => {
    const { session } = await createSession({
      sessionRef: { providerSessionId: "session-1", discoveredAt: "2026-01-01T00:00:00Z" },
    });
    request.mockImplementation(async (method) => {
      if (method === "session/resume") {
        return {
          session: {
            sessionId: "session-1",
            activeTurnId: null,
            modelId: "muse-old",
            approvalMode: { mode: "promptUnmatched" },
          },
        };
      }
      return { status: "accepted" };
    });
    await session.openThread(config);
    expect(request).toHaveBeenCalledWith(
      "session/setModel",
      expect.objectContaining({ model: { modelId: config.model } }),
    );
    expect(request).toHaveBeenCalledWith(
      "session/setApprovalMode",
      expect.objectContaining({ mode: "onRequest" }),
    );
  });

  it("keeps the Poracode dialogue usable when Muse rejects malformed resume history", async () => {
    const { session, runtimeEvents } = await createSession({
      sessionRef: { providerSessionId: "session-broken", discoveredAt: "2026-01-01T00:00:00Z" },
    });
    request.mockImplementation(async (method) => {
      if (method === "session/resume") {
        throw new Error("internal error: classify turns: session fork rejected: MalformedJsonl");
      }
      if (method === "session/start") return { session: sessionRecord("session-fresh") };
      return { status: "accepted" };
    });

    await expect(session.openThread(config)).resolves.toBe("session-fresh");
    expect(request).toHaveBeenCalledWith(
      "session/start",
      expect.objectContaining({ modelId: config.model }),
    );
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "warning",
        message: expect.stringContaining("kept this dialogue"),
      }),
    );
  });

  it("rotates a Muse session whose materialized view has a stale sidecar", async () => {
    const { session, runtimeEvents } = await createSession({
      sessionRef: { providerSessionId: "session-stale", discoveredAt: "2026-01-01T00:00:00Z" },
    });
    request.mockImplementation(async (method) => {
      if (method === "session/resume") {
        throw new Error(
          "internal error: read materialized session view: forward fold range read failed: materialized projection head: stale sidecar generation",
        );
      }
      if (method === "session/start") return { session: sessionRecord("session-fresh") };
      return { status: "accepted" };
    });

    await expect(session.openThread(config)).resolves.toBe("session-fresh");
    expect(request).toHaveBeenCalledWith(
      "session/start",
      expect.objectContaining({ modelId: config.model }),
    );
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "warning",
        message: expect.stringContaining("kept this dialogue"),
      }),
    );
  });

  it("keeps the Poracode dialogue usable when another client owns the Muse session", async () => {
    const { session, runtimeEvents } = await createSession({
      sessionRef: { providerSessionId: "session-busy", discoveredAt: "2026-01-01T00:00:00Z" },
    });
    request.mockImplementation(async (method) => {
      if (method === "session/resume") {
        throw new Error("session session-busy is already in use");
      }
      if (method === "session/start") return { session: sessionRecord("session-fresh") };
      return { status: "accepted" };
    });

    await expect(session.openThread(config)).resolves.toBe("session-fresh");
    expect(request).toHaveBeenCalledWith(
      "session/start",
      expect.objectContaining({ modelId: config.model }),
    );
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "warning",
        message: expect.stringContaining("kept this dialogue"),
      }),
    );
  });

  it("maps approvals and structured questions to canonical requests", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);
    notificationHandler?.("approval/requested", {
      sessionId: "session-1",
      approvalId: "approval-1",
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "allow", decision: "approved", label: "Allow", scope: "once" },
        { choiceId: "deny", decision: "denied", label: "Deny", scope: "once" },
      ],
      subject: { kind: "shell", command: "pwd" },
      toolName: "shell",
    });
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "request.opened",
        requestId: "approval-1",
        requestType: "command_execution_approval",
      }),
    );
    await session.resolveServerRequest("approval-1", { optionId: "deny" });
    expect(request).toHaveBeenCalledWith(
      "approval/decide",
      expect.objectContaining({ approvalId: "approval-1", choiceId: "deny" }),
    );
    expect(runtimeEvents).not.toContainEqual(
      expect.objectContaining({ type: "request.resolved", requestId: "approval-1" }),
    );
    notificationHandler?.("approval/resolved", {
      sessionId: "session-1",
      approvalId: "approval-1",
      decision: "approvedPolicyAmendment",
    });
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "request.resolved",
        requestId: "approval-1",
        outcome: "accepted",
      }),
    );

    notificationHandler?.("userInput/requested", {
      sessionId: "session-1",
      userInputId: "input-1",
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Choose a color",
          selection: { mode: "single" },
          options: [{ label: "Blue", description: "Calm" }],
        },
      ],
    });
    await session.resolveServerRequest("input-1", { answers: { color: "Blue" } });
    expect(request).toHaveBeenCalledWith(
      "userInput/answer",
      expect.objectContaining({
        userInputId: "input-1",
        answers: [{ questionId: "color", selectedLabel: "Blue" }],
      }),
    );
    expect(runtimeEvents).not.toContainEqual(
      expect.objectContaining({ type: "request.resolved", requestId: "input-1" }),
    );
    notificationHandler?.("userInput/settled", {
      sessionId: "session-1",
      userInputId: "input-1",
      outcome: "answered",
      answers: [{ questionId: "color", freeText: "Red" }],
    });
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "item.started",
        itemType: "question_answer",
        payload: {
          questions: [expect.objectContaining({ question: "Choose a color", customAnswer: "Red" })],
        },
      }),
    );

    notificationHandler?.("userInput/requested", {
      sessionId: "session-1",
      userInputId: "input-multiple",
      questions: [
        {
          id: "tags",
          question: "Choose tags",
          selection: { mode: "multiple" },
          options: [{ label: "Known" }],
        },
      ],
    });
    await session.resolveServerRequest("input-multiple", {
      answers: { tags: "Custom tag" },
    });
    expect(request).toHaveBeenCalledWith(
      "userInput/answer",
      expect.objectContaining({
        userInputId: "input-multiple",
        answers: [{ questionId: "tags", freeText: "Custom tag" }],
      }),
    );
    notificationHandler?.("userInput/settled", {
      sessionId: "session-1",
      userInputId: "input-multiple",
      outcome: "interrupted",
    });
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "request.resolved",
        requestId: "input-multiple",
        outcome: "cancelled",
      }),
    );
  });

  it("keeps a replacement approval stage pending across the decide acknowledgement", async () => {
    let releaseDecision!: (value: Record<string, unknown>) => void;
    const decision = new Promise<Record<string, unknown>>((resolve) => {
      releaseDecision = resolve;
    });
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);
    request.mockImplementation(async (method) => {
      if (method === "approval/decide") return decision;
      return { status: "accepted" };
    });
    const first = {
      sessionId: "session-1",
      approvalId: "approval-1",
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
      availableChoices: [{ choiceId: "allow-1", decision: "approved", label: "Allow" }],
      subject: { kind: "shell", command: "pwd" },
    };
    notificationHandler?.("approval/requested", first);
    const resolving = session.resolveServerRequest("approval-1", { optionId: "allow-1" });
    notificationHandler?.("approval/updated", {
      ...first,
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 1 },
      availableChoices: [{ choiceId: "allow-2", decision: "approved", label: "Allow next" }],
    });
    releaseDecision({ status: "accepted", terminal: false });
    await resolving;
    expect(runtimeEvents.filter((event) => event.type === "request.resolved")).toHaveLength(0);
    await session.resolveServerRequest("approval-1", { optionId: "allow-2" });
    expect(request).toHaveBeenLastCalledWith(
      "approval/decide",
      expect.objectContaining({
        requirementId: { approvalId: "approval-1", sourceIndex: 1 },
        choiceId: "allow-2",
      }),
    );
  });

  it("preserves attention for other pending requests", async () => {
    const { session, updates } = await createSession();
    await session.openThread(config);
    notificationHandler?.("approval/requested", {
      sessionId: "session-1",
      approvalId: "approval-1",
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
      availableChoices: [{ choiceId: "deny", decision: "denied", label: "Deny" }],
      subject: { kind: "shell", command: "pwd" },
    });
    notificationHandler?.("userInput/requested", {
      sessionId: "session-1",
      userInputId: "input-1",
      questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
    });
    await session.resolveServerRequest("input-1", { optionId: "Yes" });
    notificationHandler?.("userInput/settled", {
      sessionId: "session-1",
      userInputId: "input-1",
      outcome: "answered",
      answers: [{ questionId: "q", selectedLabel: "Yes" }],
    });
    expect(updates.at(-1)).toMatchObject({
      status: "needs_approval",
      attention: "needs_approval",
    });
  });

  it("prioritizes a pending question regardless of request arrival order", async () => {
    const { session, updates } = await createSession();
    await session.openThread(config);
    notificationHandler?.("userInput/requested", {
      sessionId: "session-1",
      userInputId: "input-1",
      questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
    });
    notificationHandler?.("approval/requested", {
      sessionId: "session-1",
      approvalId: "approval-1",
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
      availableChoices: [{ choiceId: "deny", decision: "denied", label: "Deny" }],
      subject: { kind: "shell", command: "pwd" },
    });
    expect(updates.at(-1)).toMatchObject({ status: "needs_reply", attention: "needs_reply" });
  });

  it("waits for turn/started when Muse queues a start acknowledgement", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);
    request.mockImplementation(async (method) =>
      method === "turn/start"
        ? { turnId: "turn-queued", status: "accepted", disposition: "queued" }
        : { status: "accepted" },
    );
    await session.startTurn("queued", config);
    expect(runtimeEvents).not.toContainEqual(
      expect.objectContaining({ type: "turn.started", turnId: "turn-queued" }),
    );
    notificationHandler?.("turn/started", { sessionId: "session-1", turnId: "turn-queued" });
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({ type: "turn.started", turnId: "turn-queued" }),
    );
  });

  it("steers the turn returned by an in-flight start instead of queueing another start", async () => {
    let releaseStart!: (value: Record<string, unknown>) => void;
    const startResult = new Promise<Record<string, unknown>>((resolve) => {
      releaseStart = resolve;
    });
    const { session } = await createSession();
    await session.openThread(config);
    request.mockImplementation(async (method) => {
      if (method === "turn/start") return startResult;
      return { status: "accepted" };
    });

    const starting = session.startTurn("first", config);
    const steering = session.steerTurn("follow-up", config);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    releaseStart({ turnId: "turn-delayed", status: "accepted", disposition: "started" });
    await Promise.all([starting, steering]);

    expect(request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      "turn/steer",
      expect.objectContaining({ expectedTurnId: "turn-delayed" }),
    );
  });

  it("falls back to a fresh turn when a steer loses the completion race", async () => {
    const { session } = await createSession();
    await session.openThread(config);
    await session.startTurn("first", config);
    request.mockImplementation(async (method) => {
      if (method === "turn/steer") {
        throw new MspRpcError("turn is no longer active", {
          code: -32030,
          kind: "commandRejected",
        });
      }
      if (method === "turn/start") {
        return { turnId: "turn-2", status: "accepted", disposition: "started" };
      }
      return { status: "accepted" };
    });
    await session.steerTurn("follow-up", config, undefined, { userMessageItemId: "user-2" });
    expect(request.mock.calls.map(([method]) => method)).toContain("turn/steer");
    expect(request.mock.calls.map(([method]) => method)).toContain("turn/start");
  });

  it("retargets a steer when a newer turn starts before the stale rejection", async () => {
    const { session } = await createSession();
    await session.openThread(config);
    await session.startTurn("first", config);
    let steerCount = 0;
    request.mockImplementation(async (method) => {
      if (method === "turn/steer" && steerCount++ === 0) {
        notificationHandler?.("turn/started", { sessionId: "session-1", turnId: "turn-2" });
        throw new MspRpcError("old turn completed", {
          code: -32030,
          kind: "commandRejected",
        });
      }
      return { status: "accepted" };
    });
    await session.steerTurn("redirect", config);
    const steerCalls = request.mock.calls.filter(([method]) => method === "turn/steer");
    expect(steerCalls).toHaveLength(2);
    expect(steerCalls[1]?.[1]).toMatchObject({ expectedTurnId: "turn-2" });
    expect(request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("aliases Muse steer user messages to the optimistic item", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);
    await session.startTurn("first", config);
    await session.steerTurn("redirect", config, undefined, { userMessageItemId: "user-steer" });
    const steer = request.mock.calls.find(([method]) => method === "turn/steer");
    notificationHandler?.("item/completed", {
      sessionId: "session-1",
      item: {
        itemId: "provider-steer",
        commandId: steer?.[1]?.["commandId"],
        kind: "userMessage",
        status: "completed",
        text: "redirect",
        steered: true,
      },
    });
    // The steer paints the row itself; the provider echo must not add a second.
    expect(
      runtimeEvents.filter(
        (event) => event.type === "item.started" && event.itemType === "user_message",
      ),
    ).toEqual([expect.objectContaining({ itemId: "user-steer" })]);
  });

  it("paints the steered user message when the caller supplies no optimistic id", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);
    await session.startTurn("first", config);
    await session.steerTurn("redirect", config);
    const started = runtimeEvents.filter(
      (event): event is Extract<RuntimeEvent, { type: "item.started" }> =>
        event.type === "item.started" && event.itemType === "user_message",
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      payload: { content: [{ kind: "text", text: "redirect" }] },
    });
    const itemId = started[0]?.itemId;
    expect(
      runtimeEvents.some((event) => event.type === "item.completed" && event.itemId === itemId),
    ).toBe(true);
  });

  it("keeps one user row when a rejected steer falls back to a fresh turn", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);
    await session.startTurn("first", config);
    request.mockImplementation(async (method) => {
      if (method === "turn/steer") {
        throw new MspRpcError("turn is no longer active", {
          code: -32030,
          kind: "commandRejected",
        });
      }
      if (method === "turn/start") {
        return { turnId: "turn-2", status: "accepted", disposition: "started" };
      }
      return { status: "accepted" };
    });
    await session.steerTurn("redirect", config);
    const start = request.mock.calls.findLast(([method]) => method === "turn/start");
    const started = runtimeEvents.filter(
      (event) => event.type === "item.started" && event.itemType === "user_message",
    );
    expect(started).toHaveLength(1);
    notificationHandler?.("item/completed", {
      sessionId: "session-1",
      item: {
        itemId: "provider-start",
        commandId: start?.[1]?.["commandId"],
        kind: "userMessage",
        status: "completed",
        text: "redirect",
      },
    });
    expect(
      runtimeEvents.filter(
        (event) => event.type === "item.started" && event.itemType === "user_message",
      ),
    ).toHaveLength(1);
  });

  it("interrupts the exact active turn and terminates its owned host on dispose", async () => {
    const { session, child } = await createSession();
    await session.openThread(config);
    await session.startTurn("long", config);
    await session.interruptTurn();
    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      expect.objectContaining({ sessionId: "session-1", turnId: "turn-1", retract: false }),
    );
    await session.dispose();
    expect(disposeClient).toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledWith(child, {
      ownedProcessGroup: process.platform !== "win32",
    });
  });

  it("owns child Muse sessions announced by subagent items", async () => {
    const { session } = await createSession();
    await session.openThread(config);
    notificationHandler?.("item/started", {
      sessionId: "session-1",
      item: {
        itemId: "subagent-1",
        kind: "subagent",
        status: "inProgress",
        childSessionId: "session-child",
      },
    });
    expect(session.ownsProviderSession("session-1")).toBe(true);
    expect(session.ownsProviderSession("session-child")).toBe(true);
  });

  it("closes the runtime after a transport error followed by process close", async () => {
    const { child, errors, closes, runtimeEvents } = await createSession();
    child.emit("error", new Error("EPIPE"));
    child.emit("close", 1, null);
    expect(errors).toEqual(["EPIPE", "Muse MSP server exited unexpectedly (code 1)."]);
    expect(closes).toEqual(["close"]);
    expect(runtimeEvents).toContainEqual({
      type: "session.exited",
      threadId: "thread-1",
      reason: "exited",
    });
  });

  it("reports a failed write channel while the server process remains open", async () => {
    const { errors } = await createSession();

    clientErrorHandler?.(new Error("EPIPE"));

    expect(errors).toEqual(["EPIPE"]);
  });

  it("maps session/goalChanged notifications into canonical goal items", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);

    notificationHandler?.("session/goalChanged", {
      sessionId: "session-1",
      goal: {
        objective: "Deploy to staging",
        status: "active",
        percentComplete: 0,
      },
    });

    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "item.started",
        itemType: "goal",
        payload: expect.objectContaining({
          action: "set",
          objective: "Deploy to staging",
          status: "active",
        }),
      }),
    );
  });

  it("maps session/todoListChanged notifications into canonical plan items and closes on dispose", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);

    notificationHandler?.("session/todoListChanged", {
      sessionId: "session-1",
      items: [
        { text: "Check credentials", status: "completed" },
        { text: "Verify endpoints", status: "inProgress", activeForm: "Verifying endpoints..." },
        { text: "Deploy release", status: "pending" },
      ],
      revision: 1,
    });

    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "item.started",
        itemType: "plan",
        payload: {
          steps: [
            { step: "Check credentials", status: "completed" },
            { step: "Verifying endpoints...", status: "in_progress" },
            { step: "Deploy release", status: "pending" },
          ],
        },
      }),
    );

    await session.dispose();

    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        itemId: "muse-plan",
      }),
    );
  });
  const approvalNotification = {
    sessionId: "session-1",
    approvalId: "approval-auto",
    currentRequirementId: { approvalId: "approval-auto", sourceIndex: 0 },
    availableChoices: [
      { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
      { choiceId: "abort", decision: "abort", label: "Reject" },
    ],
    subject: { kind: "shell", command: "python3 - <<'PY'", stages: [] },
    toolName: "shell",
  };

  it("auto-approves host approvals under bypass policies", async () => {
    // `allowAll` still raises approvals for pipelines the host cannot parse,
    // and `muse serve` has no flag to disable them.
    const { session, runtimeEvents, updates } = await createSession({
      config: { ...config, approvalPolicy: "yolo" },
    });
    await session.openThread({ ...config, approvalPolicy: "yolo" });
    // A resumed host can echo its old mode after Poracode has reconciled it.
    // The user's bypass selection remains authoritative for host approvals.
    notificationHandler?.("session/approvalModeChanged", {
      sessionId: "session-1",
      mode: "onRequest",
    });
    expect(updates.at(-1)?.config?.approvalPolicy).toBe("yolo");
    notificationHandler?.("approval/requested", approvalNotification);
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith(
      "approval/decide",
      expect.objectContaining({ approvalId: "approval-auto", choiceId: "allow_once" }),
    );
    expect(runtimeEvents).not.toContainEqual(
      expect.objectContaining({ type: "request.opened", requestId: "approval-auto" }),
    );
  });

  it("continues auto-approval when Muse advances a pipeline before decide settles", async () => {
    let releaseFirstDecision!: (value: Record<string, unknown>) => void;
    const firstDecision = new Promise<Record<string, unknown>>((resolve) => {
      releaseFirstDecision = resolve;
    });
    let decideCalls = 0;
    const { session, runtimeEvents } = await createSession({
      config: { ...config, approvalPolicy: "yolo" },
    });
    await session.openThread({ ...config, approvalPolicy: "yolo" });
    request.mockImplementation(async (method) => {
      if (method === "approval/decide" && decideCalls++ === 0) return firstDecision;
      return { status: "accepted" };
    });

    notificationHandler?.("approval/requested", approvalNotification);
    notificationHandler?.("approval/updated", {
      ...approvalNotification,
      currentRequirementId: { approvalId: "approval-auto", sourceIndex: 1 },
      availableChoices: [
        { choiceId: "allow-next", decision: "approved", label: "Allow next", scope: "once" },
      ],
    });
    releaseFirstDecision({ status: "accepted", terminal: false });

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "approval/decide",
        expect.objectContaining({
          approvalId: "approval-auto",
          requirementId: { approvalId: "approval-auto", sourceIndex: 1 },
          choiceId: "allow-next",
        }),
      );
    });
    expect(runtimeEvents).not.toContainEqual(
      expect.objectContaining({ type: "request.opened", requestId: "approval-auto" }),
    );
  });

  it("recovers and auto-approves an approval missed by push delivery", async () => {
    const { session, runtimeEvents } = await createSession({
      config: { ...config, approvalPolicy: "yolo" },
    });
    request.mockImplementation(async (method) => {
      if (method === "session/start") return { session: sessionRecord() };
      if (method === "approval/listPending") {
        return { approvals: [approvalNotification], userInputs: [] };
      }
      return { status: "accepted" };
    });
    await session.openThread({ ...config, approvalPolicy: "yolo" });

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "approval/decide",
        expect.objectContaining({ approvalId: "approval-auto", choiceId: "allow_once" }),
      );
    });
    expect(runtimeEvents).not.toContainEqual(
      expect.objectContaining({ type: "request.opened", requestId: "approval-auto" }),
    );
    await session.dispose();
  });

  it("surfaces an approval if an automatic bypass decision fails", async () => {
    const { session, runtimeEvents, updates } = await createSession({
      config: { ...config, approvalPolicy: "yolo" },
    });
    await session.openThread({ ...config, approvalPolicy: "yolo" });
    request.mockImplementation(async (method) => {
      if (method === "approval/decide") throw new Error("approval command rejected");
      return { status: "accepted" };
    });

    notificationHandler?.("approval/requested", approvalNotification);

    await vi.waitFor(() => {
      expect(runtimeEvents).toContainEqual(
        expect.objectContaining({ type: "request.opened", requestId: "approval-auto" }),
      );
      expect(updates.at(-1)).toMatchObject({
        status: "needs_approval",
        attention: "needs_approval",
      });
    });
  });

  it("still surfaces host approvals under ask policies", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);
    notificationHandler?.("approval/requested", approvalNotification);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalledWith("approval/decide", expect.anything());
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({ type: "request.opened", requestId: "approval-auto" }),
    );
  });

  it("never auto-answers structured questions under bypass policies", async () => {
    const { session, runtimeEvents } = await createSession({
      config: { ...config, approvalPolicy: "yolo" },
    });
    await session.openThread({ ...config, approvalPolicy: "yolo" });
    notificationHandler?.("userInput/requested", {
      sessionId: "session-1",
      userInputId: "input-auto",
      questions: [
        {
          id: "color",
          question: "Choose a color",
          selection: { mode: "single" },
          options: [{ label: "Blue" }],
        },
      ],
    });
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({ type: "request.opened", requestId: "input-auto" }),
    );
    expect(request).not.toHaveBeenCalledWith("userInput/answer", expect.anything());
  });

  const compactionItem = {
    itemId: "item-compaction",
    kind: "compaction",
    // Real 1.0.3 wire shape: the item is tagged with the PREVIOUS turn's id.
    turnId: "turn-earlier",
    status: "completed",
    fallbackText: "Context compaction",
    outcome: "compacted",
    trigger: "manual",
  };

  it("routes /compact through session/compact instead of a turn", async () => {
    const { session, updates, runtimeEvents } = await createSession();
    await session.openThread(config);
    await session.startTurn("/compact", config);
    expect(request).toHaveBeenCalledWith(
      "session/compact",
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(request).not.toHaveBeenCalledWith("turn/start", expect.anything());
    // The command only acks; the compaction item arrives seconds later, so the
    // turn has to stay open until then — the submitting renderer paints
    // "working" optimistically and only a *changed* status clears it.
    expect(runtimeEvents).toContainEqual(expect.objectContaining({ type: "turn.started" }));
    expect(runtimeEvents.at(-1)?.type).not.toBe("turn.completed");
    expect(updates.at(-1)?.status).toBe("working");

    notificationHandler?.("item/started", { sessionId: "session-1", item: compactionItem });
    expect(updates.at(-1)?.status).toBe("working");
    notificationHandler?.("item/completed", { sessionId: "session-1", item: compactionItem });

    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "item.started",
        itemType: "tool_call",
        payload: expect.objectContaining({ name: "ContextCompaction", status: "success" }),
      }),
    );
    // Nothing may follow `turn.completed`: a trailing item event re-opens the
    // settled GUI turn in the renderer and nothing would close it again.
    expect(runtimeEvents.at(-1)).toEqual(
      expect.objectContaining({ type: "turn.completed", state: "completed" }),
    );
    expect(updates.at(-1)?.status).toBe("idle");
    expect(updates.at(-1)?.attention).toBe("none");
  });

  it("completes the compact turn when no compaction item ever arrives", async () => {
    vi.useFakeTimers();
    try {
      const { session, updates } = await createSession();
      await session.openThread(config);
      await session.startTurn("/compact", config);
      expect(updates.at(-1)?.status).toBe("working");
      vi.advanceTimersByTime(30_000);
      expect(updates.at(-1)?.status).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a pending compact locally instead of interrupting an unknown turn", async () => {
    const { session, updates } = await createSession();
    await session.openThread(config);
    await session.startTurn("/compact", config);
    await session.interruptTurn();
    expect(request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
    expect(updates.at(-1)?.status).toBe("idle");
  });

  it("warns when the host reports nothing to compact", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);
    request.mockImplementation(async (method) => {
      if (method === "session/compact") return { status: "noop", reason: "History is empty." };
      return { status: "accepted" };
    });
    await session.startTurn("/compact", config);
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({ type: "warning", message: "History is empty." }),
    );
    // Nothing will be compacted, so there is no item to wait for.
    expect(runtimeEvents.at(-1)).toEqual(
      expect.objectContaining({ type: "turn.completed", state: "completed" }),
    );
  });
});

describe("Muse MSP todo list mapping", () => {
  it("maps todo create/update/complete/cancel into plan steps", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);
    notificationHandler?.("session/todoListChanged", {
      sessionId: "session-1",
      items: [
        { status: "pending", text: "First" },
        { status: "inProgress", text: "Second", activeForm: "Working on second" },
        { status: "completed", text: "Third" },
        { status: "cancelled", text: "Fourth" },
      ],
    });
    const planEvent = runtimeEvents.find(
      (event) => event.type === "item.started" && event.itemType === "plan",
    );
    if (planEvent?.type !== "item.started" || planEvent.itemType !== "plan") {
      throw new Error("expected a plan item.started event");
    }
    const payload = planEvent.payload as {
      steps: Array<{ step: string; status: string }>;
    };
    expect(payload.steps).toEqual([
      { step: "First", status: "pending" },
      { step: "Working on second", status: "in_progress" },
      { step: "Third", status: "completed" },
      { step: "Fourth (cancelled)", status: "completed" },
    ]);
  });

  it("clears the plan when the todo list empties", async () => {
    const { session, runtimeEvents } = await createSession();
    await session.openThread(config);
    notificationHandler?.("session/todoListChanged", {
      sessionId: "session-1",
      items: [{ status: "pending", text: "Only" }],
    });
    notificationHandler?.("session/todoListChanged", { sessionId: "session-1", items: [] });
    const lastPlanUpdate = [...runtimeEvents]
      .reverse()
      .find(
        (event) =>
          event.type === "item.updated" &&
          Array.isArray((event.payload as { steps?: unknown } | undefined)?.steps),
      );
    if (lastPlanUpdate?.type !== "item.updated") {
      throw new Error("expected a plan item.updated event after clearing the list");
    }
    expect((lastPlanUpdate.payload as { steps: unknown[] }).steps).toEqual([]);
  });
});
