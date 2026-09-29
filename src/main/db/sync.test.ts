import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrWatch, Project, Thread } from "@/shared/contracts";
import { closeDatabase, initDatabase } from "./connection";
import {
  dbDeleteProject,
  dbGetProjects,
  dbGetState,
  dbGetThread,
  dbGetThreads,
  dbUpsertProject,
  dbUpsertThread,
} from "./projectsThreads";
import { dbApplyThreadRuntimeEvents, dbGetThreadRuntimeItems } from "./runtimeItems";
import { dbSyncAll } from "./sync";
import { dbGetProjectNotes, dbSetProjectNotes } from "./notes";
import { dbGetPrWatch, dbGetPrWatches, dbUpsertPrWatch } from "./prWatches";

const serverNativeBinding = join(process.cwd(), "dist", "server-native", "better_sqlite3.node");
let nativeBindingEnv: string | undefined;
let sqliteAvailable = true;
try {
  new Database(":memory:").close();
} catch {
  if (existsSync(serverNativeBinding)) {
    nativeBindingEnv = serverNativeBinding;
  } else {
    sqliteAvailable = false;
  }
}

const project: Project = {
  id: "project-1",
  name: "Test project",
  location: { kind: "posix", path: "/tmp/project" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

function remoteStartedThread(): Thread {
  return {
    id: "thread-remote",
    projectId: project.id,
    title: "Started from a remote client",
    agentKind: "claude",
    config: { model: "claude-opus-5" },
    status: "launching",
    attention: "none",
    canResumeWithConfig: false,
    archived: false,
    done: false,
    starred: false,
    presentationMode: "gui",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function persistLaunchUserMessage(threadId: string): void {
  dbApplyThreadRuntimeEvents(threadId, [
    { type: "turn.started", threadId, turnId: "turn-1" },
    {
      type: "item.started",
      threadId,
      itemId: "user-1",
      itemType: "user_message",
      payload: { content: [{ kind: "text", text: "fix the sidebar" }] },
    },
    { type: "item.completed", threadId, itemId: "user-1" },
  ]);
}

describe.skipIf(!sqliteAvailable)("dbSyncAll thread ownership", () => {
  let dir: string;
  let databasePath: string;

  beforeEach(() => {
    if (nativeBindingEnv) {
      process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING = nativeBindingEnv;
    }
    dir = mkdtempSync(join(tmpdir(), "poracode-sync-db-test-"));
    databasePath = join(dir, "state.sqlite");
    initDatabase(databasePath);
    dbUpsertProject(project, 0);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING;
  });

  it("keeps a main-created thread (and its launch transcript) that the renderer has not mirrored yet", () => {
    dbUpsertThread(remoteStartedThread(), 0);
    persistLaunchUserMessage("thread-remote");

    // Renderer flushes its store before the forwarded `start` command lands.
    dbSyncAll([project], [], JSON.stringify({ kind: "home" }));

    expect(dbGetThread("thread-remote")).not.toBeNull();
    expect(dbGetThreadRuntimeItems("thread-remote").map((item) => item.type)).toEqual([
      "user_message",
    ]);
  });

  it("still deletes a thread the renderer dropped after it had mirrored it", () => {
    dbUpsertThread(remoteStartedThread(), 0);
    persistLaunchUserMessage("thread-remote");

    // Renderer applied the command: its snapshot now carries the thread.
    dbSyncAll([project], [remoteStartedThread()], JSON.stringify({ kind: "home" }));
    expect(dbGetThreadRuntimeItems("thread-remote")).toHaveLength(1);

    // The user deletes it in the renderer.
    dbSyncAll([project], [], JSON.stringify({ kind: "home" }));

    expect(dbGetThread("thread-remote")).toBeNull();
    expect(dbGetThreadRuntimeItems("thread-remote")).toEqual([]);
  });

  it("rehomes duplicate-project threads before deleting the duplicate row", () => {
    const duplicate: Project = {
      ...project,
      id: "project-duplicate",
      name: "Duplicate",
      location: { kind: "posix", path: "/tmp/project/" },
    };
    dbUpsertProject(duplicate, 1);
    const duplicateThread = {
      ...remoteStartedThread(),
      id: "thread-duplicate",
      projectId: duplicate.id,
    };
    dbUpsertThread(duplicateThread, 1);
    persistLaunchUserMessage(duplicateThread.id);

    dbSyncAll(
      [project],
      [duplicateThread],
      JSON.stringify({ kind: "draft", projectId: duplicate.id }),
    );

    expect(dbGetProjects().map((item) => item.id)).toEqual([project.id]);
    expect(dbGetThread(duplicateThread.id)?.projectId).toBe(project.id);
    expect(JSON.parse(dbGetState("view")!)).toEqual({ kind: "draft", projectId: project.id });
    expect(dbGetThreadRuntimeItems(duplicateThread.id).map((item) => item.type)).toEqual([
      "user_message",
    ]);
  });

  it("recovers an omitted original's settings and unseen transcript, then allows settings to be cleared", () => {
    const original = {
      ...project,
      scripts: {
        setupScript: "custom setup",
        actions: [{ id: "test", name: "Test", command: "test" }],
      },
      searchSettings: { useIgnoreFiles: false },
    };
    const duplicate: Project = {
      ...project,
      id: "newest",
      createdAt: "2027-01-01T00:00:00.000Z",
      scripts: { setupScript: "auto-detected setup", actions: [] },
    };
    dbUpsertProject(original, 1);
    dbUpsertProject(duplicate, 0);
    const originalThread = remoteStartedThread();
    dbUpsertThread(originalThread, 0);
    persistLaunchUserMessage(originalThread.id);
    // An older renderer already dropped the original row from its snapshot.
    dbSyncAll([duplicate], [], JSON.stringify({ kind: "draft", projectId: duplicate.id }));
    expect(dbGetProjects()).toEqual([original]);
    expect(dbGetThreadRuntimeItems(originalThread.id)).toHaveLength(1);
    expect(JSON.parse(dbGetState("view")!)).toEqual({ kind: "draft", projectId: original.id });

    const cleared = { ...project, createdAt: original.createdAt };
    dbSyncAll([cleared], [originalThread], JSON.stringify({ kind: "home" }));
    expect(dbGetProjects()).toEqual([cleared]);
    // Once repaired, ordinary renderer deletions are still authoritative.
    dbSyncAll([], [], JSON.stringify({ kind: "home" }));
    expect(dbGetProjects()).toEqual([]);
    expect(dbGetThreadRuntimeItems(originalThread.id)).toEqual([]);
  });

  it.each([false, true])(
    "merges settings before dropping incoming or persisted duplicates (incoming=%s)",
    (incoming) => {
      const duplicate: Project = {
        ...project,
        id: "newest",
        createdAt: "2026-02-01T00:00:00.000Z",
        scripts: {
          cleanupScript: "cleanup",
          actions: [{ id: "test", name: "Test", command: "test" }],
        },
        searchSettings: { useIgnoreFiles: false },
      };
      dbUpsertProject(duplicate, 0);
      dbSyncAll(incoming ? [duplicate, project] : [project], [], JSON.stringify({ kind: "home" }));
      expect(dbGetProjects()).toEqual([
        {
          ...project,
          scripts: duplicate.scripts,
          searchSettings: duplicate.searchSettings,
        },
      ]);
    },
  );

  it("recreates a missing canonical row before rehoming and preserves an unseen thread once", () => {
    dbDeleteProject(project.id);
    const duplicate: Project = {
      ...project,
      id: "project-duplicate-only",
      location: { kind: "posix", path: "/tmp/project/" },
    };
    dbUpsertProject(duplicate, 0);
    const duplicateThread = {
      ...remoteStartedThread(),
      id: "thread-unseen",
      projectId: duplicate.id,
    };
    dbUpsertThread(duplicateThread, 0);
    persistLaunchUserMessage(duplicateThread.id);

    dbSyncAll([project], [], JSON.stringify({ kind: "home" }));

    expect(dbGetProjects().map((item) => item.id)).toEqual([project.id]);
    expect(dbGetThread(duplicateThread.id)?.projectId).toBe(project.id);
    expect(dbGetThreadRuntimeItems(duplicateThread.id).map((item) => item.type)).toEqual([
      "user_message",
    ]);
  });

  it("normalizes duplicate project ids in an incoming snapshot before upserting threads", () => {
    const duplicate: Project = {
      ...project,
      id: "project-incoming-duplicate",
      location: { kind: "posix", path: "/tmp/project/" },
    };
    const duplicateThread = {
      ...remoteStartedThread(),
      id: "thread-incoming-duplicate",
      projectId: duplicate.id,
    };

    dbSyncAll(
      [project, duplicate],
      [duplicateThread],
      JSON.stringify({ kind: "draft", projectId: duplicate.id }),
    );

    expect(dbGetProjects().map((item) => item.id)).toEqual([project.id]);
    expect(dbGetThread(duplicateThread.id)?.projectId).toBe(project.id);
    expect(JSON.parse(dbGetState("view")!)).toEqual({ kind: "draft", projectId: project.id });
  });

  it("keeps both documents and to-do lists when duplicate projects have populated notes", () => {
    const duplicate = {
      ...project,
      id: "duplicate-with-notes",
      createdAt: "2027-01-01T00:00:00.000Z",
    };
    dbUpsertProject(duplicate, 1);
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    const todo = (text: string) => ({
      id: "same-todo-id",
      text,
      done: false,
      createdAt: project.createdAt,
    });
    dbSetProjectNotes({
      projectId: project.id,
      doc: { type: "doc", content: [paragraph("first")] },
      todos: [todo("first task")],
      updatedAt: project.createdAt,
    });
    dbSetProjectNotes({
      projectId: duplicate.id,
      doc: { type: "doc", content: [paragraph("second")] },
      todos: [todo("second task")],
      updatedAt: project.createdAt,
    });
    dbSyncAll([project], [], JSON.stringify({ kind: "home" }));
    const notes = dbGetProjectNotes(project.id);
    expect(notes?.doc).toEqual({ type: "doc", content: [paragraph("first"), paragraph("second")] });
    expect(notes?.todos.map((item) => item.text)).toEqual(["first task", "second task"]);
    expect(new Set(notes?.todos.map((item) => item.id)).size).toBe(2);
    expect(dbGetProjectNotes(duplicate.id)).toBeNull();
  });

  it.each([
    {
      canonicalActive: null,
      duplicateActive: "watch-duplicate",
      preferred: "duplicate",
      paused: false,
    },
    {
      canonicalActive: "watch-canonical",
      duplicateActive: "watch-duplicate",
      preferred: "canonical",
      paused: true,
    },
    { canonicalActive: null, duplicateActive: null, preferred: "duplicate", paused: false },
    {
      canonicalActive: "watch-canonical",
      duplicateActive: "watch-canonical",
      preferred: "canonical",
      paused: false,
    },
    {
      canonicalActive: null,
      duplicateActive: "watch-duplicate",
      preferred: "duplicate",
      paused: true,
      alreadyPaused: true,
    },
  ])(
    "reconciles colliding PR watches while preserving their fix threads: $preferred/$paused",
    (scenario) => {
      const { canonicalActive, duplicateActive, preferred, paused } = scenario;
      const duplicate = {
        ...project,
        id: "duplicate-with-watch",
        createdAt: "2027-01-01T00:00:00.000Z",
      };
      dbUpsertProject(duplicate, 1);
      const threads = [
        { ...remoteStartedThread(), id: "watch-canonical", projectId: project.id },
        { ...remoteStartedThread(), id: "watch-duplicate", projectId: duplicate.id },
      ];
      threads.forEach((thread, index) => dbUpsertThread(thread, index));
      const makeWatch = (
        projectId: string,
        label: string,
        activeThreadId: string | null,
        enabled: boolean,
      ): PrWatch => ({
        projectId,
        prNumber: 42,
        headBranch: "fix",
        worktreePath: `/worktrees/${label}`,
        watchEnabled: enabled,
        autoMerge: enabled,
        agentKind: "test-agent",
        config: { model: label },
        activeThreadId,
        lastCheckKey: `${label}-checkpoint`,
        lastCommentCursor: label,
        lastReviewCursor: label,
        lastReviewCommentCursor: label,
        lastError: `${label}-error`,
        blockedReason: null,
      });
      const canonicalWatch = makeWatch(
        project.id,
        "canonical",
        canonicalActive,
        Boolean(canonicalActive),
      );
      const duplicateWatch = makeWatch(duplicate.id, "duplicate", duplicateActive, true);
      if ("alreadyPaused" in scenario && scenario.alreadyPaused) {
        canonicalWatch.blockedReason = "duplicate-project-watches";
      }
      dbUpsertPrWatch(canonicalWatch);
      dbUpsertPrWatch(duplicateWatch);

      dbSyncAll([project], threads, JSON.stringify({ kind: "home" }));

      const selected = preferred === "canonical" ? canonicalWatch : duplicateWatch;
      expect(dbGetPrWatches()).toHaveLength(1);
      expect(dbGetPrWatch(project.id, 42)).toEqual({
        ...selected,
        projectId: project.id,
        ...(paused
          ? {
              watchEnabled: false,
              autoMerge: false,
              lastError: null,
              blockedReason: "duplicate-project-watches",
            }
          : {}),
      });
      expect(dbGetThread("watch-canonical")?.projectId).toBe(project.id);
      expect(dbGetThread("watch-duplicate")?.projectId).toBe(project.id);
    },
  );

  // Rows written before provider switching existed are already on disk with
  // their original agent_kind. Both upsert paths omitted agent_kind from their
  // conflict-set, which silently pinned such a row to its first provider.
  it("moves an existing thread row to its new provider, keeping the transcript", () => {
    dbUpsertThread(remoteStartedThread(), 0);
    persistLaunchUserMessage("thread-remote");
    expect(dbGetThread("thread-remote")?.agentKind).toBe("claude");

    const switched: Thread = {
      ...remoteStartedThread(),
      agentKind: "copilot",
      config: { model: "gpt-5" },
    };
    dbSyncAll([project], [switched], JSON.stringify({ kind: "home" }));

    expect(dbGetThread("thread-remote")?.agentKind).toBe("copilot");
    expect(dbGetThreadRuntimeItems("thread-remote").map((item) => item.type)).toEqual([
      "user_message",
    ]);
  });

  it("moves an existing thread row to its new provider through dbUpsertThread", () => {
    dbUpsertThread(remoteStartedThread(), 0);
    expect(dbGetThread("thread-remote")?.agentKind).toBe("claude");

    dbUpsertThread({ ...remoteStartedThread(), agentKind: "codex" }, 0);

    expect(dbGetThread("thread-remote")?.agentKind).toBe("codex");
  });

  it("persists thread workspace tags through a full renderer sync", () => {
    const tagged: Thread = {
      ...remoteStartedThread(),
      id: "thread-tagged",
      workspaceId: "ws-work",
    };
    const untagged: Thread = { ...remoteStartedThread(), id: "thread-untagged" };

    // Insert path: a fresh row carries its tag through the first sync.
    dbSyncAll([project], [tagged, untagged], JSON.stringify({ kind: "home" }));
    expect(dbGetThread("thread-tagged")?.workspaceId).toBe("ws-work");
    expect(dbGetThread("thread-untagged")?.workspaceId).toBeUndefined();

    // Conflict-update path: moving the thread files it under the new workspace…
    dbSyncAll([project], [{ ...tagged, workspaceId: "ws-side" }, untagged], "{}");
    expect(dbGetThread("thread-tagged")?.workspaceId).toBe("ws-side");

    // …and un-filing clears the column instead of leaving the old value.
    const { workspaceId: _dropped, ...unfiled } = tagged;
    dbSyncAll([project], [unfiled, untagged], "{}");
    expect(dbGetThread("thread-tagged")?.workspaceId).toBeUndefined();
  });

  it("preserves rows written by another app after the renderer baseline", () => {
    const original = { ...remoteStartedThread(), id: "thread-original", title: "Original" };
    const external = { ...remoteStartedThread(), id: "thread-external", title: "External" };
    dbUpsertThread(original, 0);

    const baseProjects = [project];
    const baseThreads = [original];
    dbUpsertThread(external, 1);
    dbUpsertThread({ ...original, title: "Renamed externally" }, 0);

    // A stale renderer persists an unrelated view update. It must neither
    // delete the newly-created row nor restore its old copy of original.
    dbSyncAll([project], [original], "{}", baseProjects, baseThreads);
    expect(dbGetThread("thread-original")?.title).toBe("Renamed externally");
    expect(dbGetThread("thread-external")?.title).toBe("External");

    // An explicit deletion is scoped to rows that renderer actually knew.
    dbSyncAll([project], [], "{}", baseProjects, baseThreads);
    expect(dbGetThreads().map((thread) => thread.id)).toEqual(["thread-external"]);
  });

  it("waits for another app's WAL writer instead of failing with SQLITE_BUSY", async () => {
    const childScript = `
      const Database = require("better-sqlite3");
      const options = process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING
        ? { nativeBinding: process.env.PORACODE_BETTER_SQLITE3_NATIVE_BINDING }
        : undefined;
      const sqlite = new Database(process.argv[1], options);
      sqlite.pragma("journal_mode = WAL");
      sqlite.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      setTimeout(() => {
        sqlite.exec("COMMIT");
        sqlite.close();
      }, 250);
    `;
    const writer = spawn(process.execPath, ["-e", childScript, databasePath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    writer.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const writerExit = new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString())),
      );
    });
    await new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.stdout.once("data", (chunk: Buffer) => {
        if (chunk.toString().includes("locked")) resolve();
        else reject(new Error(`Unexpected writer output: ${chunk.toString()}`));
      });
      void writerExit.catch(reject);
    });

    expect(() => dbSyncAll([project], [], JSON.stringify({ kind: "home" }))).not.toThrow();
    await writerExit;
  });
});
