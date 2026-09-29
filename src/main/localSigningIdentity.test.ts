import { describe, expect, it } from "vitest";
import { isLocalMacSignature, usesLocalSigningIdentity } from "./localSigningIdentity";

describe("usesLocalSigningIdentity", () => {
  it("uses the local identity when it is baked into the desktop bundle", () => {
    expect(usesLocalSigningIdentity(undefined, true, "")).toBe(true);
  });

  it("keeps the runtime override for development and diagnostics", () => {
    expect(usesLocalSigningIdentity("1", false, "")).toBe(true);
  });

  it("detects an ad-hoc runtime signature when the build flag was omitted", () => {
    expect(
      usesLocalSigningIdentity(
        undefined,
        false,
        "Executable=/Applications/Poracode Nightly.app/Contents/MacOS/Poracode Nightly\nSignature=adhoc\nTeamIdentifier=not set",
      ),
    ).toBe(true);
  });

  it("preserves the official signing identity by default", () => {
    const officialSignature =
      "Authority=Developer ID Application: Poracode\nTeamIdentifier=ABCDE12345";
    expect(usesLocalSigningIdentity(undefined, false, officialSignature)).toBe(false);
    expect(usesLocalSigningIdentity("0", false, officialSignature)).toBe(false);
  });
});

describe("isLocalMacSignature", () => {
  it("recognizes ad-hoc and unsigned applications", () => {
    expect(isLocalMacSignature("Signature=adhoc\nTeamIdentifier=not set")).toBe(true);
    expect(isLocalMacSignature("code object is not signed at all")).toBe(true);
  });

  it("does not downgrade a Developer ID application", () => {
    expect(
      isLocalMacSignature(
        "Authority=Developer ID Application: Poracode\nTeamIdentifier=ABCDE12345",
      ),
    ).toBe(false);
  });
});
