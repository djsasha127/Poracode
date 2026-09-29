import type { SharedSettings } from "@/shared/settings";
import type { UsageHistoryProvider } from "../runtime/usageHistoryProvider";
import { createCodexUsageHistoryProvider } from "./codex/usageHistoryIndex";

interface UsageHistoryProviderOptions {
  cacheDir: string;
  readSettings(): SharedSettings;
}

/** Composition root for provider-owned persistent transcript indexes. */
export function createUsageHistoryProviders(
  options: UsageHistoryProviderOptions,
): UsageHistoryProvider[] {
  return [createCodexUsageHistoryProvider(options)];
}
