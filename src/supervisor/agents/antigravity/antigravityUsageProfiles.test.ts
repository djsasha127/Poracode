import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostPort, HttpRequest } from "@poracode/agents-usage";
import { describe, expect, it } from "vitest";
import { defaultSharedSettings } from "@/shared/settings";
import {
  collectAntigravityProfileUsage,
  readAntigravityUsageProfiles,
} from "./antigravityUsageProfiles";

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
});
