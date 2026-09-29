// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { RuntimeChatItem } from "@/renderer/state/slices/runtimeEventSlice";
import type { AppStoreState } from "@/renderer/state/slices/shared";
import {
  getLatestUserMessageContent,
  getThreadErrorDockStateForItem,
  isAuthErrorMessage,
  selectThreadErrorDockStates,
} from "./threadErrorState";

function errorItem(id: string, message: string): RuntimeChatItem {
  return {
    id,
    type: "error",
    state: "completed",
    payload: { message },
    streams: {},
  };
}

describe("threadErrorState", () => {
  it("suppresses abort-only composer errors", () => {
    expect(getThreadErrorDockStateForItem(errorItem("err-1", "Aborted"))).toBeNull();
    expect(getThreadErrorDockStateForItem(errorItem("err-2", "AbortError: aborted"))).toBeNull();
  });

  it("keeps non-abort composer errors", () => {
    expect(
      getThreadErrorDockStateForItem(errorItem("err-1", "Network error: request failed")),
    ).toEqual({
      sourceItemId: "err-1",
      message: "Network error: request failed",
    });
  });

  it("returns a stable empty array when there are no errors", () => {
    const state = {
      runtimeItemIdsByThread: { "t-1": ["user-1"] },
      runtimeItemsByIdByThread: {
        "t-1": {
          "user-1": {
            id: "user-1",
            type: "user_message",
            state: "completed",
            payload: {},
            streams: {},
          },
        },
      },
    } as unknown as AppStoreState;
    expect(selectThreadErrorDockStates(state, "t-1")).toBe(
      selectThreadErrorDockStates(state, "t-1"),
    );
  });

  it("returns all errors since the latest user message in order", () => {
    const state = {
      runtimeItemIdsByThread: {
        "t-1": ["user-1", "err-a", "err-b"],
      },
      runtimeItemsByIdByThread: {
        "t-1": {
          "user-1": {
            id: "user-1",
            type: "user_message",
            state: "completed",
            payload: {},
            streams: {},
          },
          "err-a": errorItem("err-a", "Usage limit reached."),
          "err-b": errorItem("err-b", "Internal error"),
        },
      },
    } as unknown as AppStoreState;
    expect(selectThreadErrorDockStates(state, "t-1")).toEqual([
      { sourceItemId: "err-a", message: "Usage limit reached." },
      { sourceItemId: "err-b", message: "Internal error" },
    ]);
  });

  it("copies the latest top-level user prompt for an explicit retry", () => {
    const state = {
      runtimeItemIdsByThread: { "t-1": ["user-1", "child", "user-2", "error"] },
      runtimeItemsByIdByThread: {
        "t-1": {
          "user-1": {
            id: "user-1",
            type: "user_message",
            state: "completed",
            payload: { content: [{ kind: "text", text: "old" }] },
            streams: {},
          },
          child: {
            id: "child",
            type: "user_message",
            state: "completed",
            parentItemId: "tool-1",
            payload: { content: [{ kind: "text", text: "child" }] },
            streams: {},
          },
          "user-2": {
            id: "user-2",
            type: "user_message",
            state: "completed",
            payload: { content: [{ kind: "text", text: "retry this" }] },
            streams: {},
          },
          error: errorItem("error", "Internal server error"),
        },
      },
    } as unknown as AppStoreState;

    const content = getLatestUserMessageContent(state, "t-1");
    expect(content).toEqual([{ kind: "text", text: "retry this" }]);
    const source = (
      state.runtimeItemsByIdByThread["t-1"]!["user-2"]!.payload as {
        content: unknown[];
      }
    ).content;
    expect(content).not.toBe(source);
  });
});

describe("isAuthErrorMessage", () => {
  it.each([
    "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    "Not logged in · Please run /login",
    "Session expired. Please run /login to sign in again.",
    "authentication_failed",
    "API Error: 401",
    "oauth_org_not_allowed",
  ])("recognizes %q as an auth error", (msg) => {
    expect(isAuthErrorMessage(msg)).toBe(true);
  });

  it.each([
    "Network error: request failed",
    "Rate limit exceeded",
    "Internal server error",
    "Claude turn failed.",
  ])("does not flag %q as an auth error", (msg) => {
    expect(isAuthErrorMessage(msg)).toBe(false);
  });
});
