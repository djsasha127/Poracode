import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  INSTALL_REMOTE_RUNTIME_SCRIPT,
  LAUNCH_REMOTE_SERVER_SCRIPT,
  PROBE_REMOTE_RUNTIME_SCRIPT,
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
});
