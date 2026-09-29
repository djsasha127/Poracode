// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Thread } from "@/shared/contracts";
import { selectSidebarFavorites } from "./SidebarFavoritesSection";

function thread(id: string, projectId: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId,
    title: id,
    agentKind: "codex",
    config: { model: "gpt-5.4" },
    status: "idle",
    attention: "none",
    canResumeWithConfig: false,
    archived: false,
    done: false,
    starred: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectSidebarFavorites", () => {
  it("combines favorites from visible projects and sorts them by activity", () => {
    const favorites = selectSidebarFavorites(
      [
        thread("older", "project-a"),
        thread("newer", "project-b", { updatedAt: "2026-09-03T00:00:00.000Z" }),
        thread("ordinary", "project-a", { starred: false }),
        thread("hidden-project", "project-c"),
        thread("archived", "project-a", { archived: true }),
      ],
      new Set(["project-a", "project-b"]),
      () => true,
    );

    expect(favorites.map((item) => item.id)).toEqual(["newer", "older"]);
  });

  it("honors per-thread workspace visibility for Home favorites", () => {
    const favorites = selectSidebarFavorites(
      [thread("mine", "home"), thread("other-workspace", "home")],
      new Set(["home"]),
      (item) => item.id !== "other-workspace",
    );

    expect(favorites.map((item) => item.id)).toEqual(["mine"]);
  });
});
