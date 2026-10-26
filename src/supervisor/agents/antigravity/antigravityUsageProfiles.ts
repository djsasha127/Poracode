import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostPort, UsageSnapshot } from "@poracode/agents-usage";
import { antigravityProfileKind, parseAntigravityProfileInstanceConfig } from "@/shared/contracts";
import type { SharedSettings } from "@/shared/settings";
import { resolveNativeTildePath } from "../base/sessionFs";
import {
  type AntigravityAcpCredentials,
  resolveAntigravityAcpCredentialsCached,
} from "./antigravityAcpCredentials";
import {
  collectAntigravityCloudUsage,
  collectAntigravityCloudUsageWithAccessToken,
} from "./antigravityCloudUsage";

interface AntigravityCliTokenFile {
  token?: {
    access_token?: unknown;
    refresh_token?: unknown;
    expiry?: unknown;
  };
}

interface AntigravityCliToken {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface AntigravityProfileUsageDeps {
  resolveOAuthClient(): Promise<AntigravityAcpCredentials | undefined>;
}

const defaultDeps: AntigravityProfileUsageDeps = {
  resolveOAuthClient: resolveAntigravityAcpCredentialsCached,
};

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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readProfileToken(homeDir: string): Promise<AntigravityCliToken | undefined> {
  try {
    const raw = await readFile(
      join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as AntigravityCliTokenFile;
    const accessToken = nonEmptyString(parsed.token?.access_token);
    const refreshToken = nonEmptyString(parsed.token?.refresh_token);
    const expiry = nonEmptyString(parsed.token?.expiry);
    const parsedExpiry = expiry ? Date.parse(expiry) : Number.NaN;
    if (!accessToken && !refreshToken) return undefined;
    return {
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(Number.isFinite(parsedExpiry) ? { expiresAt: parsedExpiry } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function collectAntigravityProfileUsage(
  profile: AntigravityUsageProfile,
  host: HostPort,
  deps: AntigravityProfileUsageDeps = defaultDeps,
): Promise<UsageSnapshot> {
  const now = host.now();
  const profileToken = await readProfileToken(profile.homeDir);
  if (!profileToken) {
    return {
      providerId: profile.providerId,
      status: "auth-missing",
      windows: [],
      fetchedAt: now,
      error: "Antigravity profile is not signed in",
    };
  }

  try {
    let accessSnapshot: UsageSnapshot | undefined;
    const accessTokenStillValid =
      profileToken.accessToken &&
      (profileToken.expiresAt === undefined || profileToken.expiresAt > now + 60_000);
    if (accessTokenStillValid) {
      accessSnapshot = await collectAntigravityCloudUsageWithAccessToken(
        now,
        host,
        profileToken.accessToken!,
        profile.providerId,
      );
      if (accessSnapshot.status !== "auth-missing") return accessSnapshot;
    }

    if (!profileToken.refreshToken) {
      return (
        accessSnapshot ?? {
          providerId: profile.providerId,
          status: "auth-missing",
          windows: [],
          fetchedAt: now,
          error: "Antigravity profile token expired",
        }
      );
    }

    // The client id and secret identify the official Antigravity application,
    // not an account. Combine them with this isolated profile's refresh token
    // so quota collection never falls back to the main account's quota.
    const oauthClient = await deps.resolveOAuthClient();
    if (!oauthClient) {
      return (
        accessSnapshot ?? {
          providerId: profile.providerId,
          status: "auth-missing",
          windows: [],
          fetchedAt: now,
          error: "Antigravity profile token expired; OAuth client unavailable",
        }
      );
    }
    return await collectAntigravityCloudUsage(
      now,
      host,
      { ...oauthClient, refreshToken: profileToken.refreshToken },
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
