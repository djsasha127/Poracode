import { describe, expect, it } from "vitest";
import { resolveUsageRemoteServerId } from "./usageRemoteServer";

describe("resolveUsageRemoteServerId", () => {
  it("keeps the current thread server when one is selected", () => {
    expect(
      resolveUsageRemoteServerId("current", [{ desktopId: "fallback" }, { desktopId: "current" }], {
        fallback: { status: "online" },
        current: { status: "offline" },
      }),
    ).toBe("current");
  });

  it("uses an online server while a local thread is open", () => {
    expect(
      resolveUsageRemoteServerId(undefined, [{ desktopId: "offline" }, { desktopId: "server" }], {
        offline: { status: "offline" },
        server: { status: "online" },
      }),
    ).toBe("server");
  });

  it("does not expose an unavailable fallback server", () => {
    expect(
      resolveUsageRemoteServerId(undefined, [{ desktopId: "offline" }], {
        offline: { status: "offline" },
      }),
    ).toBeUndefined();
  });
});
