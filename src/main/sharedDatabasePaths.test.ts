import { describe, expect, it } from "vitest";
import { resolvePoracodePaths } from "@/shared/poracodePaths";
import { resolveSharedDatabasePaths } from "./sharedDatabasePaths";

describe("resolveSharedDatabasePaths", () => {
  const nightly = resolvePoracodePaths("/Users/tester/.poracode-nightly");

  it("points installed Nightly at Stable's database only", () => {
    expect(
      resolveSharedDatabasePaths({
        channel: "nightly",
        localPaths: nightly,
        isDev: false,
        hasBaseDirOverride: false,
        homeDir: "/Users/tester",
      }),
    ).toEqual({ ...nightly, dbPath: "/Users/tester/.poracode/state.sqlite" });
  });

  it("leaves Stable, development, and explicit roots isolated", () => {
    expect(
      resolveSharedDatabasePaths({
        channel: "stable",
        localPaths: resolvePoracodePaths("/Users/tester/.poracode"),
        isDev: false,
        hasBaseDirOverride: false,
      }).dbPath,
    ).toBe("/Users/tester/.poracode/state.sqlite");
    expect(
      resolveSharedDatabasePaths({
        channel: "nightly",
        localPaths: nightly,
        isDev: true,
        hasBaseDirOverride: false,
      }),
    ).toBe(nightly);
    expect(
      resolveSharedDatabasePaths({
        channel: "nightly",
        localPaths: nightly,
        isDev: false,
        hasBaseDirOverride: true,
      }),
    ).toBe(nightly);
  });
});
