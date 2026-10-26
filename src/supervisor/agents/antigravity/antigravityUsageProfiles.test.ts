import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostPort, HttpRequest } from "@poracode/agents-usage";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultSharedSettings } from "@/shared/settings";
import {
  collectAntigravityProfileUsage,
  readAntigravityUsageProfiles,
} from "./antigravityUsageProfiles";
import { resetAntigravityCloudUsageCacheForTests } from "./antigravityCloudUsage";

const NOW = 1_717_000_000_000;
const SUMMARY = JSON.stringify({
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { window: "5h", remainingFraction: 0.25 },
        { window: "weekly", remainingFraction: 0.5 },
      ],
    },
  ],
});

beforeEach(() => resetAntigravityCloudUsageCacheForTests());

describe("Antigravity profile usage", () => {
  it("reads the isolated CLI token and keeps the profile provider id", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "poracode-antigravity-profile-usage-"));
    try {
      const tokenDir = join(homeDir, ".gemini", "antigravity-cli");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(
        join(tokenDir, "antigravity-oauth-token"),
        JSON.stringify({ token: { access_token: "profile-access-token" } }),
        "utf8",
      );
      const profiles = readAntigravityUsageProfiles({
        ...defaultSharedSettings,
        agentInstances: {
          work: {
            id: "work",
            driver: "antigravity",
            displayName: "Work",
            config: { homeDir },
          },
        },
      });
      const profile = profiles.get("antigravity:work");
      expect(profile).toEqual({ providerId: "antigravity:work", homeDir });

      const requests: HttpRequest[] = [];
      const host: HostPort = {
        now: () => NOW,
        credentials: {
          getOAuthToken: async () => undefined,
          getSecret: async () => undefined,
        },
        http: {
          request: async (request) => {
            requests.push(request);
            if (request.url.endsWith(":retrieveUserQuotaSummary")) {
              return { status: 200, headers: {}, body: SUMMARY };
            }
            return { status: 404, headers: {}, body: "" };
          },
        },
      };

      const snapshot = await collectAntigravityProfileUsage(profile!, host);

      expect(snapshot).toMatchObject({ providerId: "antigravity:work", status: "ok" });
      expect(snapshot.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["antigravity:gemini:session-5h", 75],
        ["antigravity:gemini:weekly", 50],
      ]);
      expect(requests[0]?.headers?.Authorization).toBe("Bearer profile-access-token");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reports an unsigned profile without querying the global account", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "poracode-antigravity-profile-empty-"));
    try {
      let requests = 0;
      const snapshot = await collectAntigravityProfileUsage(
        { providerId: "antigravity:fresh", homeDir },
        {
          now: () => NOW,
          credentials: {
            getOAuthToken: async () => undefined,
            getSecret: async () => undefined,
          },
          http: {
            request: async () => {
              requests += 1;
              return { status: 200, headers: {}, body: "{}" };
            },
          },
        },
      );
      expect(snapshot).toMatchObject({
        providerId: "antigravity:fresh",
        status: "auth-missing",
      });
      expect(requests).toBe(0);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("refreshes an expired profile token with the official OAuth client", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "poracode-antigravity-profile-refresh-"));
    try {
      const tokenDir = join(homeDir, ".gemini", "antigravity-cli");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(
        join(tokenDir, "antigravity-oauth-token"),
        JSON.stringify({
          token: {
            access_token: "expired-access-token",
            refresh_token: "profile-refresh-token",
            expiry: new Date(NOW - 1_000).toISOString(),
          },
        }),
        "utf8",
      );
      const requests: HttpRequest[] = [];
      const host: HostPort = {
        now: () => NOW,
        credentials: {
          getOAuthToken: async () => undefined,
          getSecret: async () => undefined,
        },
        http: {
          request: async (request) => {
            requests.push(request);
            if (request.url === "https://oauth2.googleapis.com/token") {
              return {
                status: 200,
                headers: {},
                body: JSON.stringify({ access_token: "refreshed-access-token" }),
              };
            }
            if (request.url.endsWith(":retrieveUserQuotaSummary")) {
              return { status: 200, headers: {}, body: SUMMARY };
            }
            return { status: 404, headers: {}, body: "" };
          },
        },
      };

      const snapshot = await collectAntigravityProfileUsage(
        { providerId: "antigravity:donor", homeDir },
        host,
        {
          resolveOAuthClient: async () => ({
            clientId: "official-client-id",
            clientSecret: "official-client-secret",
            refreshToken: "main-account-refresh-token",
          }),
        },
      );

      expect(snapshot).toMatchObject({ providerId: "antigravity:donor", status: "ok" });
      expect(requests[0]?.body).toContain("refresh_token=profile-refresh-token");
      expect(requests[0]?.body).not.toContain("main-account-refresh-token");
      expect(requests[1]?.headers?.Authorization).toBe("Bearer refreshed-access-token");
      expect(requests.some((request) => request.body?.includes("expired-access-token"))).toBe(
        false,
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("refreshes after Cloud Code rejects a profile access token", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "poracode-antigravity-profile-rejected-"));
    try {
      const tokenDir = join(homeDir, ".gemini", "antigravity-cli");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(
        join(tokenDir, "antigravity-oauth-token"),
        JSON.stringify({
          token: {
            access_token: "rejected-access-token",
            refresh_token: "profile-refresh-token",
          },
        }),
        "utf8",
      );
      const authorizations: string[] = [];
      const host: HostPort = {
        now: () => NOW,
        credentials: {
          getOAuthToken: async () => undefined,
          getSecret: async () => undefined,
        },
        http: {
          request: async (request) => {
            if (request.url === "https://oauth2.googleapis.com/token") {
              return {
                status: 200,
                headers: {},
                body: JSON.stringify({ access_token: "refreshed-access-token" }),
              };
            }
            if (request.url.endsWith(":retrieveUserQuotaSummary")) {
              authorizations.push(request.headers?.Authorization ?? "");
              if (request.headers?.Authorization === "Bearer rejected-access-token") {
                return { status: 403, headers: {}, body: "" };
              }
              return { status: 200, headers: {}, body: SUMMARY };
            }
            return { status: 404, headers: {}, body: "" };
          },
        },
      };

      const snapshot = await collectAntigravityProfileUsage(
        { providerId: "antigravity:donor", homeDir },
        host,
        {
          resolveOAuthClient: async () => ({
            clientId: "official-client-id",
            clientSecret: "official-client-secret",
            refreshToken: "unused-main-refresh-token",
          }),
        },
      );

      expect(snapshot).toMatchObject({ providerId: "antigravity:donor", status: "ok" });
      expect(authorizations).toEqual([
        "Bearer rejected-access-token",
        "Bearer refreshed-access-token",
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
