import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChannelElectronUserDataDir } from "./channelIdentity";

describe("resolveChannelElectronUserDataDir", () => {
  const stableDefault = join("Users", "sasha", "Library", "Application Support", "poracode");

  it("preserves Electron's stable profile directory", () => {
    expect(resolveChannelElectronUserDataDir(stableDefault, "stable")).toBe(stableDefault);
  });

  it("gives Nightly a sibling Chromium profile", () => {
    expect(resolveChannelElectronUserDataDir(stableDefault, "nightly")).toBe(
      join("Users", "sasha", "Library", "Application Support", "poracode-nightly"),
    );
  });
});
