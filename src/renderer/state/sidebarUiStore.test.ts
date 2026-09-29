import { beforeEach, describe, expect, it } from "vitest";
import { orderProjectIds, useSidebarUiStore } from "./sidebarUiStore";

type State = ReturnType<typeof useSidebarUiStore.getState>;

beforeEach(() => {
  useSidebarUiStore.setState({
    collapsedProjects: {},
    pinnedGitHubWorkflows: {},
    collapsedWorktrees: {},
    threadListLimits: {},
    flatListProjectFilter: null,
    projectOrder: [],
    footerCollapsed: false,
    editingThreadId: null,
  });
});

describe("sidebarUiStore persistence", () => {
  it("uses version 3 for persisted project order", () => {
    expect(useSidebarUiStore.persist.getOptions().version).toBe(3);
  });

  it("persists flatListProjectFilter via partialize", () => {
    useSidebarUiStore.setState({ flatListProjectFilter: ["a", "b"] });
    const partialize =
      useSidebarUiStore.persist.getOptions().partialize ?? ((state: State) => state);
    const partialized = partialize(useSidebarUiStore.getState());
    expect(partialized).toHaveProperty("flatListProjectFilter", ["a", "b"]);
  });

  it("rehydrates a v1 payload without flatListProjectFilter to the default null", () => {
    // Simulates an upgrade: the persisted JSON was written by an older build
    // that didn't know about flatListProjectFilter. The default merge
    // ({ ...currentState, ...persistedState }) keeps the initial null for the
    // absent key, so the filter rehydrates to "all projects".
    const merge =
      useSidebarUiStore.persist.getOptions().merge ??
      ((persisted: unknown, current: State) => ({ ...current, ...(persisted as object) }));
    const current = useSidebarUiStore.getState();
    const oldPayload = {
      collapsedProjects: { p1: true },
      pinnedGitHubWorkflows: { p2: [1] },
    };
    const merged = merge(oldPayload, current) as State;

    expect(merged.flatListProjectFilter).toBeNull();
    expect(merged.collapsedProjects).toEqual({ p1: true });
    expect(merged.pinnedGitHubWorkflows).toEqual({ p2: [1] });
  });

  it("rehydrates a v1 payload with flatListProjectFilter to the stored value", () => {
    const merge =
      useSidebarUiStore.persist.getOptions().merge ??
      ((persisted: unknown, current: State) => ({ ...current, ...(persisted as object) }));
    const current = useSidebarUiStore.getState();
    const newPayload = {
      collapsedProjects: {},
      pinnedGitHubWorkflows: {},
      flatListProjectFilter: ["a", "b"],
    };
    const merged = merge(newPayload, current) as State;

    expect(merged.flatListProjectFilter).toEqual(["a", "b"]);
  });

  it("persists footerCollapsed via partialize", () => {
    useSidebarUiStore.setState({ footerCollapsed: true });
    const partialize =
      useSidebarUiStore.persist.getOptions().partialize ?? ((state: State) => state);
    const partialized = partialize(useSidebarUiStore.getState());
    expect(partialized).toHaveProperty("footerCollapsed", true);
  });

  it("persists projectOrder via partialize", () => {
    useSidebarUiStore.setState({ projectOrder: ["remote", "local"] });
    const partialize =
      useSidebarUiStore.persist.getOptions().partialize ?? ((state: State) => state);
    const partialized = partialize(useSidebarUiStore.getState());
    expect(partialized).toHaveProperty("projectOrder", ["remote", "local"]);
  });

  it("migrates an expanded v1 footer to the compact v2 default once", async () => {
    const migrate = useSidebarUiStore.persist.getOptions().migrate;
    expect(migrate).toBeDefined();
    const oldPayload = {
      collapsedProjects: { p1: true },
      pinnedGitHubWorkflows: { p2: [1] },
      flatListProjectFilter: null,
      footerCollapsed: false,
    };
    const migrated = (await migrate!(oldPayload, 1)) as Partial<State>;

    expect(migrated.footerCollapsed).toBe(true);
    expect(migrated.collapsedProjects).toEqual({ p1: true });
  });

  it("preserves a user's v2 footer choice", async () => {
    const migrate = useSidebarUiStore.persist.getOptions().migrate;
    const migrated = (await migrate!({ footerCollapsed: false }, 2)) as Partial<State>;

    expect(migrated.footerCollapsed).toBe(false);
  });
});

describe("project order", () => {
  it("keeps the preferred order and appends newly discovered projects", () => {
    expect(orderProjectIds(["local", "new", "remote"], ["remote", "local", "gone"])).toEqual([
      "remote",
      "local",
      "new",
    ]);
  });

  it("reorders local and remote projects in one persistent list", () => {
    useSidebarUiStore
      .getState()
      .reorderProjectOrder("remote", "local", "before", ["local", "remote", "third"]);

    expect(useSidebarUiStore.getState().projectOrder).toEqual(["remote", "local", "third"]);
  });
});

describe("toggleFooterCollapsed", () => {
  it("flips the footer between labeled rows and the icon row", () => {
    useSidebarUiStore.getState().toggleFooterCollapsed();
    expect(useSidebarUiStore.getState().footerCollapsed).toBe(true);
    useSidebarUiStore.getState().toggleFooterCollapsed();
    expect(useSidebarUiStore.getState().footerCollapsed).toBe(false);
  });
});

describe("setFlatListProjectFilter", () => {
  it("normalizes an empty array to null", () => {
    useSidebarUiStore.setState({ flatListProjectFilter: ["a"] });
    useSidebarUiStore.getState().setFlatListProjectFilter([]);
    expect(useSidebarUiStore.getState().flatListProjectFilter).toBeNull();
  });

  it("normalizes null to null", () => {
    useSidebarUiStore.setState({ flatListProjectFilter: ["a"] });
    useSidebarUiStore.getState().setFlatListProjectFilter(null);
    expect(useSidebarUiStore.getState().flatListProjectFilter).toBeNull();
  });

  it("deduplicates project ids", () => {
    useSidebarUiStore.setState({ flatListProjectFilter: null });
    useSidebarUiStore.getState().setFlatListProjectFilter(["a", "a", "b", "b"]);
    expect(useSidebarUiStore.getState().flatListProjectFilter).toEqual(["a", "b"]);
  });

  it("skips the update when the new value equals the current", () => {
    useSidebarUiStore.setState({ flatListProjectFilter: ["a", "b"] });
    const before = useSidebarUiStore.getState().flatListProjectFilter;
    useSidebarUiStore.getState().setFlatListProjectFilter(["a", "b"]);
    expect(useSidebarUiStore.getState().flatListProjectFilter).toBe(before);
  });
});
