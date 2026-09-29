// @vitest-environment node

import { describe, expect, it } from "vitest";
import "./codex";
import "./cursor";
import "./muse";
import {
  resolveAvailableSlashCommands,
  resolveLocalSlashCommandAction,
} from "../thread/threadSlashCommands";
import { getGuiSlashCommands } from "./providerSlashCommands";

describe("provider slash-command registry", () => {
  it("builds Codex commands from the active control capabilities", () => {
    const registration = getGuiSlashCommands("codex:work");

    expect(registration).toBeDefined();
    expect(
      registration?.buildCommands({ hasEffort: false, supportsFast: false }).map(({ id }) => id),
    ).toEqual([
      "model",
      "plan",
      "agent",
      "status",
      "context",
      "review",
      "diff",
      "fork",
      "side",
      "btw",
      "tasks",
      "background",
      "resume",
      "new",
      "archive",
      "import",
      "add-dir",
      "permissions",
      "mcp",
      "plugins",
      "goal",
    ]);
    expect(
      registration?.buildCommands({ hasEffort: true, supportsFast: true }).map(({ id }) => id),
    ).toEqual([
      "model",
      "plan",
      "agent",
      "status",
      "context",
      "review",
      "diff",
      "fork",
      "side",
      "btw",
      "tasks",
      "background",
      "resume",
      "new",
      "archive",
      "import",
      "add-dir",
      "permissions",
      "mcp",
      "plugins",
      "goal",
      "effort",
      "fast",
    ]);
  });

  it("builds Cursor commands from the active control capabilities", () => {
    const registration = getGuiSlashCommands("cursor");

    expect(registration).toBeDefined();
    expect(
      registration?.buildCommands({ hasEffort: false, supportsFast: false }).map(({ id }) => id),
    ).toEqual([
      "model",
      "plan",
      "agent",
      "status",
      "context",
      "review",
      "diff",
      "fork",
      "side",
      "btw",
      "tasks",
      "background",
      "resume",
      "new",
      "archive",
      "import",
      "add-dir",
      "permissions",
      "mcp",
      "plugins",
    ]);
    expect(
      registration?.buildCommands({ hasEffort: true, supportsFast: true }).map(({ id }) => id),
    ).toEqual([
      "model",
      "plan",
      "agent",
      "status",
      "context",
      "review",
      "diff",
      "fork",
      "side",
      "btw",
      "tasks",
      "background",
      "resume",
      "new",
      "archive",
      "import",
      "add-dir",
      "permissions",
      "mcp",
      "plugins",
      "effort",
      "fast",
    ]);
  });

  it("builds Muse commands without unsupported plan or goal modes", () => {
    const registration = getGuiSlashCommands("muse");

    expect(registration).toBeDefined();
    // `/compact` is the one Muse TUI built-in the session protocol exposes.
    expect(
      registration?.buildCommands({ hasEffort: false, supportsFast: false }).map(({ id }) => id),
    ).toEqual([
      "model",
      "status",
      "context",
      "review",
      "diff",
      "fork",
      "side",
      "btw",
      "tasks",
      "background",
      "resume",
      "new",
      "archive",
      "import",
      "add-dir",
      "permissions",
      "mcp",
      "plugins",
      "compact",
    ]);
    expect(
      registration?.buildCommands({ hasEffort: true, supportsFast: false }).map(({ id }) => id),
    ).toEqual([
      "model",
      "status",
      "context",
      "review",
      "diff",
      "fork",
      "side",
      "btw",
      "tasks",
      "background",
      "resume",
      "new",
      "archive",
      "import",
      "add-dir",
      "permissions",
      "mcp",
      "plugins",
      "compact",
      "effort",
    ]);
  });

  it("offers Cursor local commands only under the SDK runtime", () => {
    const sdk = resolveAvailableSlashCommands(undefined, undefined, {
      agentKind: "cursor",
      presentationMode: "gui",
      runtimeLabel: "SDK",
    });
    expect(sdk.map(({ id }) => id)).toEqual([
      "model",
      "plan",
      "agent",
      "status",
      "context",
      "review",
      "diff",
      "fork",
      "side",
      "btw",
      "tasks",
      "background",
      "resume",
      "new",
      "archive",
      "import",
      "add-dir",
      "permissions",
      "mcp",
      "plugins",
    ]);

    // ACP sessions keep the commands cursor-agent reports itself.
    const acp = resolveAvailableSlashCommands(
      [{ id: "summarize", label: "summarize" }],
      undefined,
      { agentKind: "cursor", presentationMode: "gui", runtimeLabel: "ACP" },
    );
    expect(acp.map(({ id }) => id)).toEqual(["summarize"]);

    expect(
      resolveLocalSlashCommandAction("/model", {
        agentKind: "cursor",
        presentationMode: "gui",
        runtimeLabel: "SDK",
      }),
    ).toEqual({ kind: "open-control", target: "model" });
    expect(
      resolveLocalSlashCommandAction("/model", {
        agentKind: "cursor",
        presentationMode: "gui",
        runtimeLabel: "ACP",
      }),
    ).toBeNull();
  });

  it.each([
    [" /MODEL ", { kind: "open-control", target: "model" }],
    ["/effort", { kind: "open-control", target: "effort" }],
    ["/fast", { kind: "toggle-fast" }],
    ["/plan", { kind: "set-mode", mode: "plan" }],
    ["/agent", { kind: "set-mode", mode: "agent" }],
    ["/status", { kind: "open-surface", target: "status" }],
    ["/context", { kind: "open-surface", target: "context" }],
    ["/review", { kind: "open-surface", target: "review" }],
    ["/diff", { kind: "open-surface", target: "diff" }],
    ["/fork", { kind: "open-surface", target: "fork" }],
    ["/side", { kind: "open-surface", target: "side" }],
    ["/btw", { kind: "open-surface", target: "side" }],
    ["/tasks", { kind: "open-surface", target: "tasks" }],
    ["/background", { kind: "open-surface", target: "tasks" }],
    ["/resume", { kind: "open-surface", target: "resume" }],
    ["/new", { kind: "open-surface", target: "new" }],
    ["/archive", { kind: "open-surface", target: "archive" }],
    ["/import", { kind: "open-surface", target: "import" }],
    ["/add-dir", { kind: "open-surface", target: "add-dir" }],
    ["/permissions", { kind: "open-surface", target: "permissions" }],
    ["/mcp", { kind: "open-surface", target: "mcp" }],
    ["/plugins", { kind: "open-surface", target: "plugins" }],
    ["/goal", null],
  ])("resolves local action %s", (typed, expected) => {
    expect(getGuiSlashCommands("codex")?.resolveLocalAction(typed)).toEqual(expected);
    expect(getGuiSlashCommands("cursor")?.resolveLocalAction(typed)).toEqual(expected);
  });

  it.each([
    [" /MODEL ", { kind: "open-control", target: "model" }],
    ["/effort", { kind: "open-control", target: "effort" }],
    ["/fast", null],
    ["/plan", null],
    ["/agent", null],
    ["/status", { kind: "open-surface", target: "status" }],
    ["/context", { kind: "open-surface", target: "context" }],
    ["/review", { kind: "open-surface", target: "review" }],
    ["/diff", { kind: "open-surface", target: "diff" }],
    ["/fork", { kind: "open-surface", target: "fork" }],
    ["/side", { kind: "open-surface", target: "side" }],
    ["/btw", { kind: "open-surface", target: "side" }],
    ["/tasks", { kind: "open-surface", target: "tasks" }],
    ["/background", { kind: "open-surface", target: "tasks" }],
    ["/resume", { kind: "open-surface", target: "resume" }],
    ["/new", { kind: "open-surface", target: "new" }],
    ["/archive", { kind: "open-surface", target: "archive" }],
    ["/import", { kind: "open-surface", target: "import" }],
    ["/add-dir", { kind: "open-surface", target: "add-dir" }],
    ["/permissions", { kind: "open-surface", target: "permissions" }],
    ["/mcp", { kind: "open-surface", target: "mcp" }],
    ["/plugins", { kind: "open-surface", target: "plugins" }],
    ["/goal", null],
  ])("resolves Muse local action %s", (typed, expected) => {
    expect(getGuiSlashCommands("muse")?.resolveLocalAction(typed)).toEqual(expected);
  });
});
