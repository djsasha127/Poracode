import type { UsageSnapshotEnricher } from "../runtime/usageService";
import { createKimiUsageSnapshotEnricher } from "./kimi/usageHistory";
import { createMuseUsageSnapshotEnricher } from "./muse/usageHistory";

/** Composition-root registry for provider-owned usage-history hooks. */
export function createUsageSnapshotEnrichers(): UsageSnapshotEnricher[] {
  return [createMuseUsageSnapshotEnricher(), createKimiUsageSnapshotEnricher()];
}
