import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertDesktopBuildChannel,
  writeDesktopBuildChannelStamp,
} from "./desktop-build-channel.mjs";

function withRepo(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), "poracode-build-channel-"));
  mkdirSync(join(repoRoot, "dist"));
  try {
    run(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

await test("accepts a matching desktop build channel", () => {
  withRepo((repoRoot) => {
    writeDesktopBuildChannelStamp(repoRoot, "nightly");
    assert.doesNotThrow(() => assertDesktopBuildChannel(repoRoot, "nightly"));
  });
});

await test("rejects a mismatched desktop build channel", () => {
  withRepo((repoRoot) => {
    writeDesktopBuildChannelStamp(repoRoot, "stable");
    assert.throws(
      () => assertDesktopBuildChannel(repoRoot, "nightly"),
      /built for stable, but packaging requested nightly/,
    );
  });
});

await test("rejects a missing or invalid desktop build channel stamp", () => {
  withRepo((repoRoot) => {
    assert.throws(
      () => assertDesktopBuildChannel(repoRoot, "nightly"),
      /build channel stamp is missing/,
    );
    writeFileSync(join(repoRoot, "dist", ".poracode-build-channel.json"), "not json\n");
    assert.throws(
      () => assertDesktopBuildChannel(repoRoot, "nightly"),
      /build channel stamp is invalid/,
    );
  });
});
