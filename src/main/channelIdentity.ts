import { dirname, join } from "node:path";
import { electronUserDataDirNameFor, type PoracodeChannel } from "@/shared/channel";

/**
 * Keep Electron-owned Chromium state (cookies, partitions, singleton locks)
 * isolated between stable and nightly packages. Electron derives both builds'
 * default from the shared npm package name, so Nightly must opt into a sibling
 * profile explicitly before Chromium or the single-instance lock initializes.
 */
export function resolveChannelElectronUserDataDir(
  defaultUserDataDir: string,
  channel: PoracodeChannel,
): string {
  if (channel === "stable") return defaultUserDataDir;
  return join(dirname(defaultUserDataDir), electronUserDataDirNameFor(channel));
}
