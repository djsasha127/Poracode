import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedThreadLeaseManager } from "./sharedThreadLease";

describe("SharedThreadLeaseManager", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("allows different threads but rejects the same thread in another app", () => {
    const root = mkdtempSync(join(tmpdir(), "poracode-thread-leases-"));
    roots.push(root);
    const stable = new SharedThreadLeaseManager(root, "Poracode Stable");
    const nightly = new SharedThreadLeaseManager(root, "Poracode Nightly");

    stable.acquire("thread-a");
    nightly.acquire("thread-b");
    expect(() => nightly.acquire("thread-a")).toThrow(/already open in Poracode Stable/);

    stable.release("thread-a");
    expect(() => nightly.acquire("thread-a")).not.toThrow();
    nightly.releaseAll();
  });

  it("is disabled when no shared lease directory is configured", () => {
    const leases = new SharedThreadLeaseManager(undefined, "test");
    expect(() => leases.acquire("thread-a")).not.toThrow();
  });
});
