import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { PoracodeChannel } from "@/shared/channel";
import {
  resolvePoracodeBaseDir,
  resolvePoracodePaths,
  type PoracodePaths,
} from "@/shared/poracodePaths";
import type { SharedSettings } from "@/shared/settings";
import { getSqlite, resolveBetterSqliteNativeBindingOptions } from "./db/connection";
import { readSharedSettingsFile, writeSharedSettingsFile } from "./sharedSettingsFile";

type Sqlite = InstanceType<typeof Database>;
type SqliteRow = Record<string, unknown>;

const THREAD_CHILD_TABLES = [
  "thread_runtime_items",
  "thread_runtime_item_stream_chunks",
  "thread_runtime_item_stream_state",
  "thread_completed_turns",
  "thread_context_usage",
] as const;

export interface NightlyStableSyncResult {
  status: "not-nightly" | "same-root" | "source-missing" | "synced";
  projectsImported: number;
  threadsImported: number;
  settingsChanged: boolean;
}

interface NightlyStableSyncInput {
  channel: PoracodeChannel;
  targetPaths: PoracodePaths;
  stablePaths?: PoracodePaths;
}

export function resolveStableSourcePaths(homeDir?: string): PoracodePaths {
  return resolvePoracodePaths(resolvePoracodeBaseDir("stable", homeDir));
}

function emptyResult(status: NightlyStableSyncResult["status"]): NightlyStableSyncResult {
  return { status, projectsImported: 0, threadsImported: 0, settingsChanged: false };
}

function workspaceName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * Nightly keeps its own settings file, but starts in the same project-picker
 * directory as Stable and understands Stable's workspace ids. Existing Nightly
 * values win: this is a bootstrap, not a settings mirror that resets the user's
 * later Nightly choices on every launch.
 */
function mergeStableSettings(
  stablePath: string,
  targetPath: string,
): { workspaceIds: Map<string, string>; changed: boolean; target: SharedSettings } {
  const stable = readSharedSettingsFile(stablePath);
  const target = readSharedSettingsFile(targetPath);
  const workspaces = [...target.workspaces];
  const workspaceIds = new Map<string, string>();

  for (const sourceWorkspace of stable.workspaces) {
    const byId = workspaces.find((entry) => entry.id === sourceWorkspace.id);
    const byName = workspaces.find(
      (entry) => workspaceName(entry.name) === workspaceName(sourceWorkspace.name),
    );
    const existing = byId ?? byName;
    if (existing) {
      workspaceIds.set(sourceWorkspace.id, existing.id);
      continue;
    }

    const id = workspaces.some((entry) => entry.id === sourceWorkspace.id)
      ? randomUUID()
      : sourceWorkspace.id;
    workspaces.push({ ...sourceWorkspace, id });
    workspaceIds.set(sourceWorkspace.id, id);
  }

  const lastUsedProjectDirs = {
    ...stable.lastUsedProjectDirs,
    ...target.lastUsedProjectDirs,
  };
  const changed =
    JSON.stringify(workspaces) !== JSON.stringify(target.workspaces) ||
    JSON.stringify(lastUsedProjectDirs) !== JSON.stringify(target.lastUsedProjectDirs);
  const next = changed ? { ...target, workspaces, lastUsedProjectDirs } : target;
  if (changed) writeSharedSettingsFile(targetPath, next);
  return { workspaceIds, changed, target: next };
}

function tableExists(sqlite: Sqlite, table: string): boolean {
  return Boolean(
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function tableColumns(sqlite: Sqlite, table: string): string[] {
  if (!tableExists(sqlite, table)) return [];
  return (sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

function sharedColumns(source: Sqlite, target: Sqlite, table: string): string[] {
  const targetColumns = new Set(tableColumns(target, table));
  return tableColumns(source, table).filter((column) => targetColumns.has(column));
}

function prepareInsert(target: Sqlite, table: string, columns: readonly string[]) {
  const quoted = columns.map((column) => `"${column}"`).join(", ");
  const values = columns.map(() => "?").join(", ");
  return target.prepare(`INSERT OR IGNORE INTO "${table}" (${quoted}) VALUES (${values})`);
}

function rowValues(
  row: SqliteRow,
  columns: readonly string[],
  overrides: SqliteRow = {},
): unknown[] {
  return columns.map((column) =>
    Object.prototype.hasOwnProperty.call(overrides, column) ? overrides[column] : row[column],
  );
}

function projectIdentity(row: SqliteRow): string {
  return JSON.stringify([
    row["location_kind"],
    row["location_path"],
    row["location_distro"],
    row["location_linux_path"],
    row["location_unc_path"],
  ]);
}

function copyThreadChildren(source: Sqlite, target: Sqlite, threadIds: readonly string[]): void {
  if (threadIds.length === 0) return;
  for (const table of THREAD_CHILD_TABLES) {
    const columns = sharedColumns(source, target, table);
    if (columns.length === 0 || !columns.includes("thread_id")) continue;
    const rowsForThread = source.prepare(`SELECT * FROM "${table}" WHERE thread_id = ?`);
    const insert = prepareInsert(target, table, columns);
    for (const threadId of threadIds) {
      for (const row of rowsForThread.all(threadId) as SqliteRow[]) {
        insert.run(...rowValues(row, columns));
      }
    }
  }
}

/**
 * Pull new Stable projects and conversations into Nightly without ever sharing
 * a writable SQLite file between the two simultaneously-running apps.
 *
 * Stable is opened read-only under a consistent WAL snapshot. Rows already in
 * Nightly are never updated or deleted, so a conversation can safely diverge
 * after it has been opened in Nightly. A later launch imports only new rows.
 */
export function syncStableDataToNightly(input: NightlyStableSyncInput): NightlyStableSyncResult {
  if (input.channel !== "nightly") return emptyResult("not-nightly");
  const stablePaths = input.stablePaths ?? resolveStableSourcePaths();
  if (stablePaths.baseDir === input.targetPaths.baseDir) return emptyResult("same-root");
  if (!existsSync(stablePaths.dbPath)) return emptyResult("source-missing");

  const settings = mergeStableSettings(stablePaths.settingsPath, input.targetPaths.settingsPath);
  const source = new Database(stablePaths.dbPath, {
    ...resolveBetterSqliteNativeBindingOptions(),
    readonly: true,
    fileMustExist: true,
  });
  source.pragma("query_only = ON");
  source.pragma("busy_timeout = 5000");

  let projectsImported = 0;
  let threadsImported = 0;
  try {
    source.exec("BEGIN");
    const target = getSqlite();
    const result = target.transaction(() => {
      const sourceProjects = source.prepare("SELECT * FROM projects").all() as SqliteRow[];
      const targetProjects = target.prepare("SELECT * FROM projects").all() as SqliteRow[];
      const targetProjectsById = new Map(
        targetProjects.map((row) => [String(row["id"]), row] as const),
      );
      const targetProjectsByIdentity = new Map(
        targetProjects.map((row) => [projectIdentity(row), row] as const),
      );
      const projectIds = new Map<string, string>();
      const projectColumns = sharedColumns(source, target, "projects");
      const insertProject = prepareInsert(target, "projects", projectColumns);
      const primaryWorkspaceId = settings.target.workspaces[0]?.id ?? null;

      for (const project of sourceProjects) {
        const sourceId = String(project["id"]);
        const existing =
          targetProjectsById.get(sourceId) ??
          targetProjectsByIdentity.get(projectIdentity(project));
        if (existing) {
          projectIds.set(sourceId, String(existing["id"]));
          continue;
        }

        const sourceWorkspaceId = project["workspace_id"];
        const workspaceId =
          typeof sourceWorkspaceId === "string"
            ? (settings.workspaceIds.get(sourceWorkspaceId) ?? primaryWorkspaceId)
            : null;
        insertProject.run(...rowValues(project, projectColumns, { workspace_id: workspaceId }));
        projectIds.set(sourceId, sourceId);
        targetProjectsById.set(sourceId, project);
        targetProjectsByIdentity.set(projectIdentity(project), project);
        projectsImported += 1;
      }

      if (tableExists(source, "project_notes") && tableExists(target, "project_notes")) {
        const noteColumns = sharedColumns(source, target, "project_notes");
        const insertNote = prepareInsert(target, "project_notes", noteColumns);
        for (const note of source.prepare("SELECT * FROM project_notes").all() as SqliteRow[]) {
          const sourceProjectId = String(note["project_id"]);
          const targetProjectId = projectIds.get(sourceProjectId);
          if (!targetProjectId) continue;
          insertNote.run(...rowValues(note, noteColumns, { project_id: targetProjectId }));
        }
      }

      const existingThreadIds = new Set(
        (target.prepare("SELECT id FROM threads").all() as Array<{ id: string }>).map(
          (row) => row.id,
        ),
      );
      const threadColumns = sharedColumns(source, target, "threads");
      const insertThread = prepareInsert(target, "threads", threadColumns);
      const importedThreadIds: string[] = [];
      for (const thread of source.prepare("SELECT * FROM threads").all() as SqliteRow[]) {
        const threadId = String(thread["id"]);
        if (existingThreadIds.has(threadId)) continue;
        const projectId = projectIds.get(String(thread["project_id"]));
        if (!projectId) continue;
        const sourceWorkspaceId = thread["workspace_id"];
        const workspaceId =
          typeof sourceWorkspaceId === "string"
            ? (settings.workspaceIds.get(sourceWorkspaceId) ?? primaryWorkspaceId)
            : null;
        insertThread.run(
          ...rowValues(thread, threadColumns, {
            project_id: projectId,
            workspace_id: workspaceId,
            status: "inactive",
            attention: "none",
            active_turn_started_at: null,
          }),
        );
        existingThreadIds.add(threadId);
        importedThreadIds.push(threadId);
        threadsImported += 1;
      }
      copyThreadChildren(source, target, importedThreadIds);
    })();
    source.exec("COMMIT");
    void result;
  } catch (error) {
    try {
      source.exec("ROLLBACK");
    } catch {
      // Keep the original sync failure.
    }
    throw error;
  } finally {
    source.close();
  }

  return {
    status: "synced",
    projectsImported,
    threadsImported,
    settingsChanged: settings.changed,
  };
}
