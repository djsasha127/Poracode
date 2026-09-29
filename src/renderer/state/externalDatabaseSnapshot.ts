import type { Project, Thread } from "@/shared/contracts";
import { useAppStore } from "./appStore";
import { prepareForExternalDatabaseSnapshot } from "./dbStorage";
import { useExperimentStore } from "./experimentStore";

interface SnapshotAdoptionOptions {
  projectIdsBeforeRead?: ReadonlySet<string>;
  threadIdsBeforeRead?: ReadonlySet<string>;
}

/**
 * Adopt the authoritative metadata stored in the shared desktop database.
 * Remote-server projections are renderer-local, so retain them while replacing
 * local projects and threads with the database snapshot.
 */
export function adoptExternalDatabaseSnapshot(
  projects: Project[],
  threads: Thread[],
  options: SnapshotAdoptionOptions = {},
): void {
  const current = useAppStore.getState();
  const projectIds = new Set(projects.map((project) => project.id));
  const threadIds = new Set(threads.map((thread) => thread.id));
  const nextProjects = [
    ...projects,
    ...current.projects.filter(
      (project) =>
        !projectIds.has(project.id) &&
        (project.remoteServerId ||
          (options.projectIdsBeforeRead !== undefined &&
            !options.projectIdsBeforeRead.has(project.id))),
    ),
  ];
  const nextThreads = [
    ...threads,
    ...current.threads.filter(
      (thread) =>
        !threadIds.has(thread.id) &&
        (thread.remoteServerId ||
          (options.threadIdsBeforeRead !== undefined &&
            !options.threadIdsBeforeRead.has(thread.id))),
    ),
  ];

  prepareForExternalDatabaseSnapshot(projects, threads);
  useAppStore.setState({ projects: nextProjects, threads: nextThreads });
  useExperimentStore
    .getState()
    .reconcileExperiments(new Set(projects.map((project) => project.id)));
}
