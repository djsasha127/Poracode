import { spawnSync } from "node:child_process";

declare const __PORACODE_LOCAL_SIGNING_IDENTITY__: boolean | undefined;

const bakedLocalSigningIdentity =
  typeof __PORACODE_LOCAL_SIGNING_IDENTITY__ === "boolean" && __PORACODE_LOCAL_SIGNING_IDENTITY__;

function readRunningMacSignature(
  platform: NodeJS.Platform = process.platform,
  executablePath = process.execPath,
): string {
  if (platform !== "darwin") return "";
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", executablePath], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.error) return "";
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

export function isLocalMacSignature(signatureDetails: string): boolean {
  return (
    /(?:^|\n)Signature=adhoc(?:\n|$)/.test(signatureDetails) ||
    signatureDetails.includes("code object is not signed at all")
  );
}

export function usesLocalSigningIdentity(
  envValue = process.env.PORACODE_LOCAL_SIGNING_IDENTITY,
  buildValue = bakedLocalSigningIdentity,
  signatureDetails?: string,
): boolean {
  if (envValue?.trim() === "1" || buildValue) return true;
  return isLocalMacSignature(signatureDetails ?? readRunningMacSignature());
}
