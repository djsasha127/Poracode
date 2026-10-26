import { describe, expect, it } from "vitest";
import type { AgentStatus, UsageSnapshot } from "@/shared/contracts";
import { resolveAntigravityQuotaFailover } from "./quotaFailover";

function usage(providerId: string, gemini5h: number, geminiWeekly: number): UsageSnapshot {
  return {
    providerId,
    status: "ok",
    fetchedAt: 1,
    windows: [
      { id: "antigravity:gemini:session-5h", label: "Gemini · 5h", usedPercent: gemini5h },
      { id: "antigravity:gemini:weekly", label: "Gemini · Weekly", usedPercent: geminiWeekly },
    ],
  };
}

function status(kind: string, authState: AgentStatus["authState"]): AgentStatus {
  return {
    kind,
    label: kind,
    installed: true,
    authState,
    capabilities: {
      models: [],
      efforts: [],
      modelEfforts: {},
      modes: [],
      approvalPolicies: [],
      sandboxModes: [],
      supportsResume: true,
      supportsOneShot: true,
      supportsDirectInput: true,
      liveInputMode: "terminal",
      presentationMode: "terminal",
      presentationModes: ["terminal"],
      settingDefs: [],
    },
  };
}

describe("resolveAntigravityQuotaFailover", () => {
  const instances = [
    {
      id: "second",
      driver: "antigravity",
      displayName: "Second account",
      config: { homeDir: "~/.poracode/antigravity-profiles/second" },
    },
  ];

  it("routes a new Gemini terminal thread to an authenticated profile with quota", () => {
    expect(
      resolveAntigravityQuotaFailover({
        agentKind: "antigravity",
        config: { model: "Gemini 3.5 Flash" },
        instances,
        statuses: [
          status("antigravity", "authenticated"),
          status("antigravity:second", "authenticated"),
        ],
        snapshots: {
          antigravity: usage("antigravity", 100, 40),
          "antigravity:second": usage("antigravity:second", 20, 10),
        },
      }),
    ).toEqual({
      agentKind: "antigravity:second",
      switchedFrom: "antigravity",
      label: "Second account",
    });
  });

  it("treats the Antigravity default model as part of the Gemini quota pool", () => {
    expect(
      resolveAntigravityQuotaFailover({
        agentKind: "antigravity",
        config: { model: "" },
        instances,
        statuses: [
          status("antigravity", "authenticated"),
          status("antigravity:second", "authenticated"),
        ],
        snapshots: {
          antigravity: usage("antigravity", 100, 40),
          "antigravity:second": usage("antigravity:second", 20, 10),
        },
      }).agentKind,
    ).toBe("antigravity:second");
  });

  it("does not switch on unknown quota, an unsigned donor, or a GUI thread", () => {
    const snapshots = {
      antigravity: usage("antigravity", 100, 40),
      "antigravity:second": usage("antigravity:second", 20, 10),
    };
    expect(
      resolveAntigravityQuotaFailover({
        agentKind: "antigravity",
        config: { model: "Gemini 3.5 Flash" },
        instances,
        statuses: [status("antigravity:second", "unknown")],
        snapshots,
      }).agentKind,
    ).toBe("antigravity");
    expect(
      resolveAntigravityQuotaFailover({
        agentKind: "antigravity",
        config: { model: "Gemini 3.5 Flash" },
        presentationMode: "gui",
        instances,
        statuses: [status("antigravity:second", "authenticated")],
        snapshots,
      }).agentKind,
    ).toBe("antigravity");
    expect(
      resolveAntigravityQuotaFailover({
        agentKind: "antigravity",
        config: { model: "Gemini 3.5 Flash" },
        instances,
        statuses: [status("antigravity:second", "authenticated")],
        snapshots: {},
      }).agentKind,
    ).toBe("antigravity");
  });
});
