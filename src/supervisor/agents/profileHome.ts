import { mkdirSync } from "node:fs";
import type { ProjectLocation } from "@/shared/contracts";
import { toWslUncPath } from "@/shared/wsl";
import { resolveTildePath } from "./base";

/** Resolve and create a profile-owned CLI home on the target runtime. */
export function createProfileHomeEnvironment(options: {
  homeDir: string;
  envVar: string;
  blankedHostCredentials?: Readonly<Record<string, string>>;
}) {
  const homeFor = (location: ProjectLocation): string => {
    const home = resolveTildePath(options.homeDir, location);
    mkdirSync(diskHomeFor(location, home), { recursive: true });
    return home;
  };

  const diskHomeFor = (location: ProjectLocation, resolvedHome?: string): string => {
    const home = resolvedHome ?? resolveTildePath(options.homeDir, location);
    return location.kind === "wsl" ? toWslUncPath(location.distro, home) : home;
  };

  const envFor = (location: ProjectLocation): Record<string, string> => ({
    [options.envVar]: homeFor(location),
    ...(options.blankedHostCredentials ?? {}),
  });

  const withEnv = <T extends object>(
    value: T,
    location: ProjectLocation,
  ): T & { env: Record<string, string> } => ({
    ...value,
    env: {
      ...((value as { env?: Record<string, string> }).env ?? {}),
      ...envFor(location),
    },
  });

  return { homeFor, diskHomeFor, envFor, withEnv };
}
