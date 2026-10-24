import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STAMP_VERSION = 1;
const STAMP_RELATIVE_PATH = join("dist", ".poracode-build-channel.json");

function stampPath(repoRoot) {
  return join(repoRoot, STAMP_RELATIVE_PATH);
}

export function writeDesktopBuildChannelStamp(repoRoot, channel) {
  writeFileSync(
    stampPath(repoRoot),
    `${JSON.stringify({ version: STAMP_VERSION, channel }, null, 2)}\n`,
  );
}

export function assertDesktopBuildChannel(repoRoot, expectedChannel) {
  const filePath = stampPath(repoRoot);
  if (!existsSync(filePath)) {
    throw new Error(
      `Desktop build channel stamp is missing at ${filePath}. ` +
        `Run the packaging command without --skip-build for ${expectedChannel}.`,
    );
  }

  let stamp;
  try {
    stamp = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Desktop build channel stamp is invalid at ${filePath}: ${detail}`, {
      cause: error,
    });
  }

  if (stamp?.version !== STAMP_VERSION || stamp?.channel !== expectedChannel) {
    throw new Error(
      `Desktop dist was built for ${String(stamp?.channel ?? "an unknown channel")}, ` +
        `but packaging requested ${expectedChannel}. Run again without --skip-build.`,
    );
  }
}
