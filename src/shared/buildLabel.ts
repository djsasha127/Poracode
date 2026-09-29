declare const __PORACODE_BUILD_LABEL__: string | undefined;

const MAX_BUILD_LABEL_CHARS = 32;

/**
 * Optional distributor label baked into a desktop build. This deliberately
 * stays separate from the release channel: Nightly controls data/update
 * isolation, while the label tells a user which custom build they launched.
 */
export function normalizeBuildLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_BUILD_LABEL_CHARS) : "";
}

export function resolvePoracodeBuildLabel(): string {
  return normalizeBuildLabel(
    typeof __PORACODE_BUILD_LABEL__ === "string" ? __PORACODE_BUILD_LABEL__ : "",
  );
}
