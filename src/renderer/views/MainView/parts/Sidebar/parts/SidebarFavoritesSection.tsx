import { Star } from "lucide-react";
import { Trans } from "@lingui/react/macro";
import { useShallow } from "zustand/shallow";
import type { Project, Thread } from "@/shared/contracts";
import { isHomeProject } from "@/shared/homeScope";
import { ProjectIcon } from "@/renderer/components/common/ProjectIcon";
import {
  ProjectRemoteServerChip,
  useProjectRemoteServerLookup,
} from "@/renderer/components/common/ProjectRemoteServer";
import { TuxIcon } from "@/renderer/components/common/TuxIcon";
import { useAppStore } from "@/renderer/state/appStore";
import { isRemoteProjectStatusUnreachable } from "@/renderer/state/remoteServers/reachability";
import { useSidebarUiStore } from "@/renderer/state/sidebarUiStore";
import { useWorkspaceThreadFilter } from "@/renderer/state/workspaceSelectors";
import type { SidebarRow } from "./sidebarProjectRows";
import { SidebarThreadRow } from "./SidebarThreadRow";

export function selectSidebarFavorites(
  threads: readonly Thread[],
  visibleProjectIds: ReadonlySet<string>,
  isThreadVisible: (thread: Thread) => boolean,
): Thread[] {
  return threads
    .filter(
      (thread) =>
        thread.starred &&
        !thread.archived &&
        visibleProjectIds.has(thread.projectId) &&
        isThreadVisible(thread),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** One Favorites list shared by every project in the grouped sidebar. */
export function SidebarFavoritesSection(props: {
  projectIds: readonly string[];
  homeProject: Project | undefined;
  homeScopeEnabled: boolean;
}) {
  const { projects, threads } = useAppStore(
    useShallow((state) => ({ projects: state.projects, threads: state.threads })),
  );
  const remoteServerFor = useProjectRemoteServerLookup();
  const isThreadVisible = useWorkspaceThreadFilter();
  const editingThreadId = useSidebarUiStore((state) => state.editingThreadId);
  const setEditingThreadId = useSidebarUiStore((state) => state.setEditingThreadId);
  const allowedProjectIds = new Set(props.projectIds);
  if (props.homeScopeEnabled && props.homeProject) allowedProjectIds.add(props.homeProject.id);

  const projectsById = new Map<string, Project>();
  for (const project of projects) {
    if (!allowedProjectIds.has(project.id)) continue;
    const remote = remoteServerFor(project);
    if (
      !isHomeProject(project) &&
      (project.disabled || isRemoteProjectStatusUnreachable(project, remote.status))
    ) {
      continue;
    }
    projectsById.set(project.id, project);
  }
  const favorites = selectSidebarFavorites(threads, new Set(projectsById.keys()), isThreadVisible);
  if (favorites.length === 0) return null;

  return (
    <section className="space-y-0.5" data-testid="sidebar-favorites">
      <div className="flex items-center gap-1.5 px-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
        <Star className="size-3 fill-current" />
        <span>
          <Trans>Favorites</Trans>
        </span>
      </div>
      <div>
        {favorites.map((thread, threadIndex) => {
          const project = projectsById.get(thread.projectId);
          if (!project) return null;
          const remote = remoteServerFor(project);
          const row: Extract<SidebarRow, { kind: "thread" }> = {
            kind: "thread",
            key: `favorite:${thread.id}`,
            thread,
            threadIndex,
            group: "favorites",
            showWorktreeBadge: true,
            showWorktreeFilesButton: !!thread.worktreePath,
            sortDisabled: true,
          };
          return (
            <SidebarThreadRow
              key={row.key}
              row={row}
              project={project}
              editingThreadId={editingThreadId}
              setEditingThreadId={setEditingThreadId}
              projectTag={
                <span className="flex min-w-0 flex-1 items-center gap-1 text-[10px] leading-4 text-muted/70">
                  <ProjectIcon project={project} className="size-3 text-muted/70" />
                  <span className="truncate">{project.name}</span>
                  <ProjectRemoteServerChip info={remote} size="xs" />
                  {project.location.kind === "wsl" ? (
                    <TuxIcon className="h-2.5 w-auto shrink-0 text-muted/60" />
                  ) : null}
                </span>
              }
            />
          );
        })}
      </div>
    </section>
  );
}
