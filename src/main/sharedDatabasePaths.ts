import {
  resolvePoracodeBaseDir,
  resolvePoracodePaths,
  type PoracodePaths,
} from "@/shared/poracodePaths";
import type { PoracodeChannel } from "@/shared/channel";

interface ResolveSharedDatabasePathsInput {
  channel: PoracodeChannel;
  localPaths: PoracodePaths;
  isDev: boolean;
  hasBaseDirOverride: boolean;
  homeDir?: string;
}

/**
 * Installed Stable and Nightly share conversation/project storage while every
 * other path remains channel-specific (settings, auth cache, logs, plugins).
 * Explicit data roots and development builds stay isolated for tests and
 * disposable environments.
 */
export function resolveSharedDatabasePaths(input: ResolveSharedDatabasePathsInput): PoracodePaths {
  if (input.channel !== "nightly" || input.isDev || input.hasBaseDirOverride) {
    return input.localPaths;
  }

  const stablePaths = resolvePoracodePaths(resolvePoracodeBaseDir("stable", input.homeDir));
  return { ...input.localPaths, dbPath: stablePaths.dbPath };
}
