import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeBuildLabel } from "./buildLabel";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("build label", () => {
  it("trims and bounds labels intended for the title bar", () => {
    expect(normalizeBuildLabel("  Sasha  ")).toBe("Sasha");
    expect(normalizeBuildLabel("x".repeat(40))).toBe("x".repeat(32));
    expect(normalizeBuildLabel(undefined)).toBe("");
  });

  it("reads the compile-time label when one is provided", async () => {
    vi.stubGlobal("__PORACODE_BUILD_LABEL__", "Sasha");
    const mod = await import("./buildLabel");
    expect(mod.resolvePoracodeBuildLabel()).toBe("Sasha");
  });
});
