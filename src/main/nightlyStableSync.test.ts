import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, getSqlite, initDatabase } from "./db/connection";
import { resolvePoracodePaths } from "@/shared/poracodePaths";
import { defaultSharedSettings } from "@/shared/settings";
import { readSharedSettingsFile, writeSharedSettingsFile } from "./sharedSettingsFile";
import { resolveStableSourcePaths, syncStableDataToNightly } from "./nightlyStableSync";

describe("Nightly Stable data bootstrap", () => {
  let root: string | undefined;

  afterEach(() => {
    closeDatabase();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("always resolves the implicit source to Stable, even from a Nightly process", () => {
    expect(resolveStableSourcePaths("/Users/tester").baseDir).toBe("/Users/tester/.poracode");
  });

  it("imports missing conversations by project, preserves Nightly rows, and stays idempotent", () => {
    root = mkdtempSync(join(tmpdir(), "poracode-nightly-sync-"));
    const stable = resolvePoracodePaths(join(root, "stable"));
    const nightly = resolvePoracodePaths(join(root, "nightly"));
    const stableWorkspaceId = "stable-work";
    const nightlyWorkspaceId = "nightly-work";

    mkdirSync(stable.baseDir, { recursive: true });
    mkdirSync(nightly.baseDir, { recursive: true });
    initDatabase(stable.dbPath);
    getSqlite()
      .prepare(
        `INSERT INTO projects (
          id, name, location_kind, location_path, workspace_id, sort_order, created_at
        ) VALUES (?, ?, 'posix', ?, ?, 0, ?)`,
      )
      .run("stable-project", "Repository", "/repo", stableWorkspaceId, "2026-01-01T00:00:00Z");
    getSqlite()
      .prepare(
        `INSERT INTO threads (
          id, project_id, title, agent_kind, config, status, attention,
          sort_order, created_at, updated_at, presentation_mode
        ) VALUES (?, ?, ?, 'codex', '{}', 'working', 'working', 0, ?, ?, 'gui')`,
      )
      .run(
        "stable-thread",
        "stable-project",
        "Stable conversation",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:01:00Z",
      );
    getSqlite()
      .prepare(
        `INSERT INTO thread_runtime_items (
          thread_id, item_id, position, type, state, payload, streams
        ) VALUES (?, 'message-1', 0, 'message', 'completed', ?, NULL)`,
      )
      .run("stable-thread", JSON.stringify({ text: "from Stable" }));
    closeDatabase();
    writeSharedSettingsFile(stable.settingsPath, {
      ...defaultSharedSettings,
      workspaces: [
        {
          id: stableWorkspaceId,
          name: "Work",
          createdAt: "2026-01-01T00:00:00Z",
          icon: "briefcase",
        },
      ],
      lastUsedProjectDirs: { native: "/repo" },
    });

    initDatabase(nightly.dbPath);
    getSqlite()
      .prepare(
        `INSERT INTO projects (
          id, name, location_kind, location_path, workspace_id, sort_order, created_at
        ) VALUES (?, ?, 'posix', ?, ?, 0, ?)`,
      )
      .run("nightly-project", "Nightly", "/nightly", nightlyWorkspaceId, "2026-02-01T00:00:00Z");
    getSqlite()
      .prepare(
        `INSERT INTO threads (
          id, project_id, title, agent_kind, config, status, attention,
          sort_order, created_at, updated_at, presentation_mode
        ) VALUES (?, ?, ?, 'muse', '{}', 'inactive', 'none', 0, ?, ?, 'gui')`,
      )
      .run(
        "nightly-thread",
        "nightly-project",
        "Nightly conversation",
        "2026-02-01T00:00:00Z",
        "2026-02-01T00:01:00Z",
      );
    writeSharedSettingsFile(nightly.settingsPath, {
      ...defaultSharedSettings,
      workspaces: [
        {
          id: nightlyWorkspaceId,
          name: "Work",
          createdAt: "2026-02-01T00:00:00Z",
          icon: "briefcase",
        },
      ],
    });

    expect(
      syncStableDataToNightly({ channel: "nightly", targetPaths: nightly, stablePaths: stable }),
    ).toEqual({
      status: "synced",
      projectsImported: 1,
      threadsImported: 1,
      settingsChanged: true,
    });

    expect(getSqlite().prepare("SELECT id, workspace_id FROM projects ORDER BY id").all()).toEqual([
      { id: "nightly-project", workspace_id: nightlyWorkspaceId },
      { id: "stable-project", workspace_id: nightlyWorkspaceId },
    ]);
    expect(
      getSqlite()
        .prepare("SELECT id, project_id, status, attention FROM threads ORDER BY id")
        .all(),
    ).toEqual([
      {
        id: "nightly-thread",
        project_id: "nightly-project",
        status: "inactive",
        attention: "none",
      },
      {
        id: "stable-thread",
        project_id: "stable-project",
        status: "inactive",
        attention: "none",
      },
    ]);
    expect(
      getSqlite()
        .prepare("SELECT payload FROM thread_runtime_items WHERE thread_id = ?")
        .get("stable-thread"),
    ).toEqual({ payload: JSON.stringify({ text: "from Stable" }) });
    expect(readSharedSettingsFile(nightly.settingsPath).lastUsedProjectDirs).toEqual({
      native: "/repo",
    });
    expect(readSharedSettingsFile(nightly.settingsPath).workspaces).toHaveLength(1);

    expect(
      syncStableDataToNightly({ channel: "nightly", targetPaths: nightly, stablePaths: stable }),
    ).toEqual({
      status: "synced",
      projectsImported: 0,
      threadsImported: 0,
      settingsChanged: false,
    });
  });

  it("does nothing outside Nightly or when the Stable database is absent", () => {
    root = mkdtempSync(join(tmpdir(), "poracode-nightly-sync-"));
    const target = resolvePoracodePaths(join(root, "nightly"));
    const stable = resolvePoracodePaths(join(root, "missing-stable"));

    expect(
      syncStableDataToNightly({ channel: "stable", targetPaths: target, stablePaths: stable }),
    ).toMatchObject({ status: "not-nightly" });
    expect(
      syncStableDataToNightly({ channel: "nightly", targetPaths: target, stablePaths: stable }),
    ).toMatchObject({ status: "source-missing" });
  });
});
