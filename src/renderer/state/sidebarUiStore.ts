import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  isSidebarGroupCollapsed,
  SIDEBAR_THREAD_LIST_PAGE_SIZE,
} from "@/renderer/views/MainView/parts/Sidebar/parts/sidebarProjectRows";
import { reorderIds, type ReorderPlacement } from "./reorder";

/**
 * Legacy hand-rolled key, read once as the initial seed so existing installs
 * keep their collapsed projects; the `persist` envelope (PERSIST_KEY) takes
 * over on the first write.
 */
const LEGACY_COLLAPSED_PROJECTS_KEY = "poracode-collapsed-projects";
const PERSIST_KEY = "poracode-sidebar-ui";

interface SidebarUiState {
  collapsedProjects: Record<string, boolean>;
  pinnedGitHubWorkflows: Record<string, number[]>;
  collapsedWorktrees: Record<string, boolean>;
  /** Per-project count of thread-list items revealed via "See more" (ephemeral). */
  threadListLimits: Record<string, number>;
  /**
   * Flat thread list's project filter: the project ids to show, or null for
   * all projects. Persisted; additive to the persistence envelope — payloads written by
   * older builds lack the key and rehydrate to the default (null = all, the
   * pre-filter behavior), and older builds ignore the extra key.
   */
  flatListProjectFilter: string[] | null;
  /**
   * Sidebar project order, independent of the projected remote snapshot. Remote
   * refreshes replace their Project objects, so the app-store array alone cannot
   * preserve a user's mixed local/remote order.
   */
  projectOrder: string[];
  /**
   * Footer nav (workspace switcher, shortcuts, Settings, Hide sidebar) shown
   * as a compact icon row instead of labeled rows. Persistence version 2 makes
   * the compact row the one-time upgrade default, while preserving every later
   * user choice to expand it again.
   */
  footerCollapsed: boolean;
  editingThreadId: string | null;
  setProjectCollapsed: (projectId: string, collapsed: boolean) => void;
  toggleProjectCollapsed: (projectId: string) => void;
  togglePinnedGitHubWorkflow: (projectId: string, workflowId: number) => void;
  setWorktreeCollapsed: (key: string, collapsed: boolean) => void;
  toggleWorktreeCollapsed: (key: string) => void;
  revealMoreThreads: (projectId: string, pageSize?: number) => void;
  setFlatListProjectFilter: (projectIds: string[] | null) => void;
  reorderProjectOrder: (
    sourceId: string,
    targetId: string,
    placement: ReorderPlacement,
    availableProjectIds: string[],
  ) => void;
  toggleFooterCollapsed: () => void;
  setEditingThreadId: (id: string | null) => void;
}

function readCollapsedProjects(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LEGACY_COLLAPSED_PROJECTS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** Apply a persisted partial order and append newly discovered projects. */
export function orderProjectIds(
  availableProjectIds: readonly string[],
  preferredOrder: readonly string[],
): string[] {
  const available = new Set(availableProjectIds);
  const ordered = preferredOrder.filter((id) => available.delete(id));
  for (const id of availableProjectIds) {
    if (available.delete(id)) ordered.push(id);
  }
  return ordered;
}

export const useSidebarUiStore = create<SidebarUiState>()(
  persist(
    (set) => ({
      collapsedProjects: readCollapsedProjects(),
      pinnedGitHubWorkflows: {},
      collapsedWorktrees: {},
      threadListLimits: {},
      flatListProjectFilter: null,
      projectOrder: [],
      footerCollapsed: true,
      editingThreadId: null,

      setProjectCollapsed: (projectId, collapsed) =>
        set((state) => {
          if ((state.collapsedProjects[projectId] ?? false) === collapsed) return {};
          const collapsedProjects = { ...state.collapsedProjects, [projectId]: collapsed };
          // Collapsing resets the revealed page count so reopening starts fresh.
          return collapsed
            ? { collapsedProjects, threadListLimits: withoutKey(state.threadListLimits, projectId) }
            : { collapsedProjects };
        }),
      toggleProjectCollapsed: (projectId) =>
        set((state) => {
          const collapsed = !(state.collapsedProjects[projectId] ?? false);
          const collapsedProjects = { ...state.collapsedProjects, [projectId]: collapsed };
          return collapsed
            ? { collapsedProjects, threadListLimits: withoutKey(state.threadListLimits, projectId) }
            : { collapsedProjects };
        }),
      togglePinnedGitHubWorkflow: (projectId, workflowId) =>
        set((state) => {
          const current = state.pinnedGitHubWorkflows[projectId] ?? [];
          const pinned = current.includes(workflowId)
            ? current.filter((id) => id !== workflowId)
            : [...current, workflowId];
          return {
            pinnedGitHubWorkflows: {
              ...state.pinnedGitHubWorkflows,
              [projectId]: pinned,
            },
          };
        }),
      setWorktreeCollapsed: (key, collapsed) =>
        set((state) => {
          if (isSidebarGroupCollapsed(state.collapsedWorktrees, key) === collapsed) return {};
          return { collapsedWorktrees: { ...state.collapsedWorktrees, [key]: collapsed } };
        }),
      toggleWorktreeCollapsed: (key) =>
        set((state) => {
          const collapsed = !isSidebarGroupCollapsed(state.collapsedWorktrees, key);
          return {
            collapsedWorktrees: {
              ...state.collapsedWorktrees,
              [key]: collapsed,
            },
          };
        }),
      revealMoreThreads: (projectId, pageSize = SIDEBAR_THREAD_LIST_PAGE_SIZE) =>
        set((state) => {
          const current = state.threadListLimits[projectId] ?? pageSize;
          return {
            threadListLimits: {
              ...state.threadListLimits,
              [projectId]: current + pageSize,
            },
          };
        }),
      setFlatListProjectFilter: (projectIds) =>
        set((state) => {
          // An empty selection reads the same as no filter — normalize to
          // null; dedup so a stale or hand-edited payload can't double-count
          // an id and trip the complete-selection collapse downstream.
          const next = projectIds && projectIds.length > 0 ? [...new Set(projectIds)] : null;
          const current = state.flatListProjectFilter;
          if (current === next) return {};
          if (
            current !== null &&
            next !== null &&
            current.length === next.length &&
            current.every((id, index) => id === next[index])
          ) {
            return {};
          }
          return { flatListProjectFilter: next };
        }),
      reorderProjectOrder: (sourceId, targetId, placement, availableProjectIds) =>
        set((state) => {
          const current = orderProjectIds(availableProjectIds, state.projectOrder);
          const next = reorderIds(current, sourceId, targetId, placement);
          return next === current ? {} : { projectOrder: next };
        }),
      toggleFooterCollapsed: () => set((state) => ({ footerCollapsed: !state.footerCollapsed })),
      setEditingThreadId: (editingThreadId) => set({ editingThreadId }),
    }),
    {
      name: PERSIST_KEY,
      version: 3,
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState, version) => {
        const persisted = (persistedState ?? {}) as Partial<SidebarUiState>;
        return version < 2 ? { ...persisted, footerCollapsed: true } : persisted;
      },
      // Worktree collapse, "See more" limits, and inline rename are
      // session-scoped by design.
      partialize: (state) => ({
        collapsedProjects: state.collapsedProjects,
        pinnedGitHubWorkflows: state.pinnedGitHubWorkflows,
        flatListProjectFilter: state.flatListProjectFilter,
        projectOrder: state.projectOrder,
        footerCollapsed: state.footerCollapsed,
      }),
    },
  ),
);

export function useIsProjectCollapsed(projectId: string): boolean {
  return useSidebarUiStore((s) => s.collapsedProjects[projectId] ?? false);
}

export function useThreadListLimit(
  projectId: string,
  pageSize: number = SIDEBAR_THREAD_LIST_PAGE_SIZE,
): number {
  return useSidebarUiStore((s) => s.threadListLimits[projectId] ?? pageSize);
}

export function useIsWorktreeCollapsed(key: string): boolean {
  return useSidebarUiStore((s) => isSidebarGroupCollapsed(s.collapsedWorktrees, key));
}
