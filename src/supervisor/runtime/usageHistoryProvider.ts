import type {
  RefreshUsageHistoryPayload,
  UsageHistoryAggregate,
  UsageHistoryDigest,
  UsageHistoryPagePayload,
  UsageHistoryPageResponse,
} from "@/shared/contracts";

/**
 * Provider-owned persistent transcript index exposed through the shared usage
 * service. Vendor parsing, default roots, and index semantics stay behind this
 * hook; the runtime only dispatches by provider id.
 */
export interface UsageHistoryProvider {
  readonly providerId: string;
  getDigest(): Promise<UsageHistoryDigest>;
  getPage(payload: UsageHistoryPagePayload): Promise<UsageHistoryPageResponse>;
  refresh(payload: RefreshUsageHistoryPayload): Promise<UsageHistoryDigest>;
  /** Last indexed aggregate, if available. Must not block on a full first scan. */
  getCachedAggregate(): UsageHistoryAggregate | undefined;
}
