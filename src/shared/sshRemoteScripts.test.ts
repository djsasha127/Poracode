import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  INSTALL_REMOTE_RUNTIME_SCRIPT,
  LAUNCH_REMOTE_SERVER_SCRIPT,
  PROBE_REMOTE_RUNTIME_SCRIPT,
  REMOTE_AGENT_PROFILE_SYNC_FUNCTION,
  REMOTE_NODE_ENV_SCRIPT,
} from "./sshRemoteScripts";

describe("REMOTE_NODE_ENV_SCRIPT", () => {
  it("provisions a checksum-pinned private Node runtime when no system Node exists", () => {
    expect(REMOTE_NODE_ENV_SCRIPT).toContain('PORACODE_PORTABLE_NODE_VERSION="v24.10.0"');
    expect(REMOTE_NODE_ENV_SCRIPT).toContain(
      "fbc3d6e1e1d962450d058e918214373872cc4c46e08673f31c35932afac4a8c5",
    );
    expect(REMOTE_NODE_ENV_SCRIPT).toContain(
      'URL="https://nodejs.org/dist/$PORACODE_PORTABLE_NODE_VERSION/$ARCHIVE"',
    );
    expect(REMOTE_NODE_ENV_SCRIPT).toContain('prepend_path_if_dir "$FINAL/bin"');
    expect(PROBE_REMOTE_RUNTIME_SCRIPT).toContain("install_poracode_portable_node");
  });

  it("keeps every bootstrap script valid POSIX shell after embedding the downloader", () => {
    for (const script of [
      PROBE_REMOTE_RUNTIME_SCRIPT,
      INSTALL_REMOTE_RUNTIME_SCRIPT,
      LAUNCH_REMOTE_SERVER_SCRIPT,
    ]) {
      const result = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
      expect(result.status).toBe(0);
    }
  });
});

describe("LAUNCH_REMOTE_SERVER_SCRIPT", () => {
  it("mirrors host profiles without secrets while preserving helper-owned agents", () => {
    const root = mkdtempSync(join(tmpdir(), "poracode-ssh-profile-sync-"));
    const sourcePath = join(root, "host-settings.json");
    const destinationPath = join(root, "helper-settings.json");
    const statePath = join(root, "host-agent-profiles.json");
    const runSync = () =>
      spawnSync("sh", ["-s", "--", sourcePath, destinationPath, statePath, "nightly"], {
        input: `set -eu\nNODE=${JSON.stringify(process.execPath)}\n${REMOTE_AGENT_PROFILE_SYNC_FUNCTION}\nsync_host_agent_profiles "$1" "$2" "$3" "$4"\n`,
        encoding: "utf8",
      });

    try {
      writeFileSync(
        sourcePath,
        JSON.stringify({
          agentInstances: {
            donor: {
              id: "donor",
              driver: "antigravity",
              displayName: "Quota donor",
              icon: "poracode-local://host/private.svg",
              config: {
                homeDir: "~/.poracode/antigravity-profiles/donor",
                apiKey: "must-not-cross-config",
              },
              environment: { TOKEN: { value: "must-not-cross", sensitive: true } },
              authAcknowledged: { native: true },
            },
            "host-acp": {
              id: "host-acp",
              driver: "acp-generic",
              displayName: "Do not mirror",
            },
          },
        }),
      );
      writeFileSync(
        destinationPath,
        JSON.stringify({
          titleGenProvider: "codex",
          agentInstances: {
            "helper-acp": {
              id: "helper-acp",
              driver: "acp-generic",
              displayName: "Keep me",
            },
            stale: {
              id: "stale",
              driver: "kimi",
              displayName: "Removed on host",
              config: { homeDir: "/stale" },
            },
          },
        }),
      );
      writeFileSync(statePath, JSON.stringify({ channel: "nightly", ids: ["stale"] }));

      const first = runSync();
      expect(first.status).toBe(0);
      const synced = JSON.parse(readFileSync(destinationPath, "utf8")) as {
        titleGenProvider: string;
        agentInstances: Record<string, Record<string, unknown>>;
      };
      expect(synced.titleGenProvider).toBe("codex");
      expect(Object.keys(synced.agentInstances).sort()).toEqual(["donor", "helper-acp"]);
      expect(synced.agentInstances.donor).toEqual({
        id: "donor",
        driver: "antigravity",
        displayName: "Quota donor",
        config: { homeDir: "~/.poracode/antigravity-profiles/donor" },
      });
      expect(JSON.stringify(synced)).not.toContain("must-not-cross");
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
        channel: "nightly",
        ids: ["donor"],
      });

      writeFileSync(sourcePath, JSON.stringify({ agentInstances: {} }));
      const second = runSync();
      expect(second.status).toBe(0);
      const removed = JSON.parse(readFileSync(destinationPath, "utf8")) as {
        agentInstances: Record<string, unknown>;
      };
      expect(Object.keys(removed.agentInstances)).toEqual(["helper-acp"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reuse a same-version helper from an unrelated runtime hash", () => {
    expect(LAUNCH_REMOTE_SERVER_SCRIPT).toContain('ACTUAL_RUNTIME=""');
    expect(LAUNCH_REMOTE_SERVER_SCRIPT).toContain(
      '[ "$CURRENT_RUNTIME" = "$RUNTIME_HASH" ] || [ "$ACTUAL_RUNTIME" = "$RUNTIME_HASH" ]',
    );
    expect(LAUNCH_REMOTE_SERVER_SCRIPT).toContain('server_ready "$PORT" "$APP_VERSION"; then');
  });

  it("defers a compatible helper upgrade while remote threads are active", () => {
    expect(LAUNCH_REMOTE_SERVER_SCRIPT).toContain("server_has_active_threads()");
    expect(LAUNCH_REMOTE_SERVER_SCRIPT).toContain("status in ('working','starting','queued')");
    expect(LAUNCH_REMOTE_SERVER_SCRIPT).toContain(
      'server_ready "$PORT" "$APP_VERSION" 0 && server_has_active_threads',
    );
    expect(LAUNCH_REMOTE_SERVER_SCRIPT).toContain('if [ "$REUSE_SERVER" = "1" ]');
  });

  it("selects the host settings file from the connecting app channel", () => {
    expect(LAUNCH_REMOTE_SERVER_SCRIPT).toContain(
      'nightly) HOST_SETTINGS="$HOME/.poracode-nightly/settings.json"',
    );
    expect(LAUNCH_REMOTE_SERVER_SCRIPT).toContain(
      'sync_host_agent_profiles \\\n  "$HOST_SETTINGS"',
    );
  });
});
