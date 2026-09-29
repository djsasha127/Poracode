import {
  EXPERIMENT_STORE_KEY,
  EXPERIMENT_STORE_VERSION,
  type Project,
  type Thread,
} from "@/shared/contracts";
import type { DbPersistExperimentStatePayload } from "@/shared/ipc";
import { dedupeProjects, projectIdentityKey } from "@/shared/projectIdentity";
import { remapThreadProjectIds } from "@/shared/projectReferences";
import { getSqlite } from "./connection";
import {
  acknowledgeMirroredThreadIds,
  isMainCreatedThreadUnmirrored,
  noteRecoveredThreads,
} from "./mainCreatedThreads";
import { notifyProjectThreadDataChanged } from "./projectThreadChanges";
import { dbDiscardThreadRuntimeWrites } from "./runtimeItems";
import {
  prepareProjectUpsertStatement,
  prepareThreadUpsertStatement,
  runProjectUpsert,
  runThreadUpsert,
} from "./upsertStatements";
import { rowToProject, type ProjectRow } from "./rowMappers";
import { rehomeProjectReferences, remapProjectViewJson } from "./projectDeduplication";

/** Renderer snapshots never own `thread_status_source`; see ThreadUpsertOptions. */
const THREAD_SYNC_OPTIONS = { writeThreadStatusSource: false } as const;

function rowChanged<T extends { id: string }>(
  row: T,
  index: number,
  baseRows: readonly T[] | undefined,
): boolean {
  if (!baseRows) return true;
  const baseIndex = baseRows.findIndex((candidate) => candidate.id === row.id);
  return (
    baseIndex < 0 ||
    baseIndex !== index ||
    JSON.stringify(baseRows[baseIndex]) !== JSON.stringify(row)
  );
}

/**
 * Synchronize the renderer's project/thread metadata atomically.
 *
 * When a renderer supplies the snapshot it originally hydrated (`base*`), only
 * rows changed relative to that snapshot are written and only rows removed
 * from that snapshot are deleted. This prevents a simultaneously-running
 * Stable/Nightly renderer with stale in-memory state from erasing or reverting
 * rows the other process created after hydration.
 */
export function dbSyncAll(
  projectsData: Project[],
  threadsData: Thread[],
  viewJson: string,
  baseProjectsData?: Project[],
  baseThreadsData?: Thread[],
): boolean {
  const sqlite = getSqlite();
  const deletedThreadIds = new Set<string>();
  const recoveredThreadIds = new Set<string>();
  const identityOptions = { caseInsensitivePosix: process.platform === "darwin" };

  // Acquire the WAL writer reservation before reading the current rows. Stable
  // and Nightly can point at the same database, and a deferred transaction can
  // otherwise deadlock while upgrading its read lock after the other process
  // has started writing. BEGIN IMMEDIATE lets busy_timeout serialize the two
  // writers instead of surfacing SQLITE_BUSY to the renderer.
  const { repaired, projectOrThreadRowsChanged } = sqlite
    .transaction(() => {
      let rowsChanged = false;
      const existingThreads = sqlite.prepare("SELECT id, project_id FROM threads").all() as Array<{
        id: string;
        project_id: string;
      }>;
      const existingProjectRows = sqlite.prepare("SELECT * FROM projects").all() as ProjectRow[];
      const existingProjectIds = new Set(existingProjectRows.map((row) => row.id));
      const rendererProjectIds = new Set(projectsData.map((project) => project.id));
      const rendererIdentities = new Set(
        projectsData.map((project) => projectIdentityKey(project, identityOptions)),
      );
      // Recover only omitted IDs for folders the renderer still owns. Including
      // an older copy of the same ID would resurrect deliberately cleared settings.
      const persistedDuplicates = existingProjectRows
        .map(rowToProject)
        .filter(
          (project) =>
            !rendererProjectIds.has(project.id) &&
            rendererIdentities.has(projectIdentityKey(project, identityOptions)),
        );
      const { projects: incomingProjects, duplicateIds } = dedupeProjects(
        [...projectsData, ...persistedDuplicates],
        identityOptions,
      );
      const duplicateRepair = duplicateIds.size > 0;
      const incomingProjectIds = new Set(incomingProjects.map((project) => project.id));
      const recoveredProjectIds = new Set(
        incomingProjects
          .filter((project) => !rendererProjectIds.has(project.id))
          .map((project) => project.id),
      );
      const rendererOwnedProjectIds = baseProjectsData
        ? new Set(baseProjectsData.map((project) => duplicateIds.get(project.id) ?? project.id))
        : existingProjectIds;
      const deletedProjectIds = new Set(
        [...rendererOwnedProjectIds].filter((projectId) => !incomingProjectIds.has(projectId)),
      );
      const projectIdsToDelete = new Set([...deletedProjectIds, ...duplicateIds.keys()]);
      const deleteProject = sqlite.prepare("DELETE FROM projects WHERE id = ?");
      const deleteProjectNotes = sqlite.prepare("DELETE FROM project_notes WHERE project_id = ?");
      const upsertProject = prepareProjectUpsertStatement(sqlite);

      for (let i = 0; i < incomingProjects.length; i++) {
        const project = incomingProjects[i]!;
        if (
          !duplicateRepair &&
          !recoveredProjectIds.has(project.id) &&
          !rowChanged(project, i, baseProjectsData)
        ) {
          continue;
        }
        runProjectUpsert(upsertProject, project, i);
        rowsChanged = true;
      }

      // A renderer can have repaired an old duplicate before its first full
      // snapshot reaches the DB. Rehome every dependent row before deleting the
      // duplicate project: deleting the project first would cascade its threads
      // and permanently discard their runtime transcripts.
      const rehomedThreadIds = rehomeProjectReferences(sqlite, duplicateIds);
      const incomingThreads = remapThreadProjectIds(threadsData, duplicateIds);
      const baseThreads = baseThreadsData
        ? remapThreadProjectIds(baseThreadsData, duplicateIds)
        : undefined;

      for (const projectId of projectIdsToDelete) {
        if (!existingProjectIds.has(projectId)) continue;
        const result = deleteProject.run(projectId);
        deleteProjectNotes.run(projectId);
        rowsChanged ||= result.changes > 0;
      }

      const incomingThreadIds = new Set(incomingThreads.map((thread) => thread.id));
      const rendererOwnedThreadIds = baseThreads
        ? new Set(baseThreads.map((thread) => thread.id))
        : new Set(existingThreads.map((thread) => thread.id));
      const deleteThread = sqlite.prepare("DELETE FROM threads WHERE id = ?");
      const upsertThread = prepareThreadUpsertStatement(sqlite, THREAD_SYNC_OPTIONS);

      for (const { id: threadId, project_id: projectId } of existingThreads) {
        if (!rendererOwnedThreadIds.has(threadId) || incomingThreadIds.has(threadId)) continue;
        // The surviving original may itself have been absent from the renderer's
        // repaired snapshot. Both kinds of recovered thread stay main-owned until
        // a later snapshot acknowledges the broadcast, even across queued saves.
        if (rehomedThreadIds.has(threadId) || recoveredProjectIds.has(projectId)) {
          recoveredThreadIds.add(threadId);
          continue;
        }
        // A thread main just created (remote `start`, schedule, orchestrator) is
        // absent from this snapshot only because the renderer has not applied the
        // forwarded command yet. Deleting it would cascade away the launch turn's
        // runtime items — most visibly the initial `user_message`.
        if (!deletedProjectIds.has(projectId) && isMainCreatedThreadUnmirrored(threadId)) continue;
        const result = deleteThread.run(threadId);
        // Project deletion may already have removed the row through ON DELETE
        // CASCADE, but buffered runtime writes still need to be discarded.
        if (deletedProjectIds.has(projectId)) deletedThreadIds.add(threadId);
        if (result.changes > 0) {
          deletedThreadIds.add(threadId);
          rowsChanged = true;
        }
      }
      for (let i = 0; i < incomingThreads.length; i++) {
        const thread = incomingThreads[i]!;
        if (!duplicateRepair && !rowChanged(thread, i, baseThreads)) continue;
        runThreadUpsert(upsertThread, thread, i, THREAD_SYNC_OPTIONS);
        rowsChanged = true;
      }
      // Anything in this snapshot is renderer-owned from here on, so a later
      // snapshot that drops it is a real deletion.
      acknowledgeMirroredThreadIds(incomingThreadIds);

      sqlite
        .prepare(
          "INSERT INTO app_state (key, value) VALUES ('view', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(remapProjectViewJson(viewJson, duplicateIds));
      return { repaired: duplicateRepair, projectOrThreadRowsChanged: rowsChanged };
    })
    .immediate();
  noteRecoveredThreads(recoveredThreadIds);
  for (const threadId of deletedThreadIds) dbDiscardThreadRuntimeWrites(threadId);
  if (projectOrThreadRowsChanged) notifyProjectThreadDataChanged();
  return repaired;
}

export function dbPersistExperimentState(payload: DbPersistExperimentStatePayload): void {
  const sqlite = getSqlite();
  sqlite.transaction(() => {
    const deleteThread = sqlite.prepare("DELETE FROM threads WHERE id = ?");
    for (const threadId of payload.deletedThreadIds) deleteThread.run(threadId);

    const upsertThread = prepareThreadUpsertStatement(sqlite, THREAD_SYNC_OPTIONS);
    for (const { thread, sortOrder } of payload.upsertThreads) {
      runThreadUpsert(upsertThread, thread, sortOrder, THREAD_SYNC_OPTIONS);
    }

    sqlite
      .prepare(
        "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(
        EXPERIMENT_STORE_KEY,
        JSON.stringify({
          state: { experiments: payload.experiments },
          version: EXPERIMENT_STORE_VERSION,
        }),
      );
  })();
  for (const threadId of payload.deletedThreadIds) dbDiscardThreadRuntimeWrites(threadId);
}
