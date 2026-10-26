import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostPort, UsageSnapshot } from "@poracode/agents-usage";
import { antigravityProfileKind, parseAntigravityProfileInstanceConfig } from "@/shared/contracts";
import type { SharedSettings } from "@/shared/settings";
import { resolveNativeTildePath } from "../base/sessionFs";
import { collectAntigravityCloudUsageWithAccessToken } from "./antigravityCloudUsage";

interface AntigravityCliTokenFile {
  token?: { access_token?: unknown };
}

export interface AntigravityUsageProfile {
  providerId: string;
  homeDir: string;
}

export function readAntigravityUsageProfiles(
  settings: SharedSettings,
): Map<string, AntigravityUsageProfile> {
  const profiles = new Map<string, AntigravityUsageProfile>();
  for (const instance of Object.values(settings.agentInstances)) {
    if (instance.enabled === false || instance.driver !== "antigravity") continue;
    try {
      const config = parseAntigravityProfileInstanceConfig(instance.config);
      const providerId = antigravityProfileKind(instance.id);
      profiles.set(providerId, {
        providerId,
        homeDir: resolveNativeTildePath(config.homeDir),
      });
    } catch {
      // Malformed profiles are skipped by the adapter registry too.
    }
  }
  return profiles;
}

async function readProfileAccessToken(homeDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(
      join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as AntigravityCliTokenFile;
    const token = parsed.token?.access_token;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function collectAntigravityProfileUsage(
  profile: AntigravityUsageProfile,
  host: HostPort,
): Promise<UsageSnapshot> {
  const now = host.now();
  const accessToken = await readProfileAccessToken(profile.homeDir);
  if (!accessToken) {
    return {
      providerId: profile.providerId,
      status: "auth-missing",
      windows: [],
      fetchedAt: now,
      error: "Antigravity profile is not signed in",
    };
  }
  try {
    return await collectAntigravityCloudUsageWithAccessToken(
      now,
      host,
      accessToken,
      profile.providerId,
    );
  } catch (error) {
    return {
      providerId: profile.providerId,
      status: "error",
      windows: [],
      fetchedAt: now,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
