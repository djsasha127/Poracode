import {
  providerUsagePayloadSchema,
  refreshUsageHistoryPayloadSchema,
  usageApiKeyPayloadSchema,
  usageHistoryDigestPayloadSchema,
  usageHistoryPagePayloadSchema,
  usageLoginConfirmationPayloadSchema,
  usageLoginPayloadSchema,
  usageLoginStatePayloadSchema,
  type ProviderUsagePayload,
  type ProviderUsageResponse,
  type RefreshUsageHistoryPayload,
  type UsageApiKeyPayload,
  type UsageLoginConfirmationPayload,
  type UsageLoginPayload,
  type UsageLoginResult,
  type UsageLoginStatePayload,
  type UsageLoginStateResponse,
  type UsageLogoutResult,
  type UsageHistoryDigest,
  type UsageHistoryDigestPayload,
  type UsageHistoryPagePayload,
  type UsageHistoryPageResponse,
} from "../../contracts";
import { definePayloadProcedure } from "../core";

export const usageProcedures = {
  startUsageLogin: definePayloadProcedure<UsageLoginPayload, UsageLoginResult, "main-local">(
    "startUsageLogin",
    "main-local",
    usageLoginPayloadSchema,
  ),
  cancelUsageLogin: definePayloadProcedure<UsageLoginPayload, void, "main-local">(
    "cancelUsageLogin",
    "main-local",
    usageLoginPayloadSchema,
  ),
  clearUsageLogin: definePayloadProcedure<UsageLoginPayload, UsageLogoutResult, "main-local">(
    "clearUsageLogin",
    "main-local",
    usageLoginPayloadSchema,
  ),
  submitUsageApiKey: definePayloadProcedure<UsageApiKeyPayload, UsageLoginResult, "main-local">(
    "submitUsageApiKey",
    "main-local",
    usageApiKeyPayloadSchema,
  ),
  setProviderUsageApiKey: definePayloadProcedure<
    UsageApiKeyPayload,
    UsageLoginResult,
    "supervisor"
  >("setProviderUsageApiKey", "supervisor", usageApiKeyPayloadSchema),
  resolveUsageLoginConfirmation: definePayloadProcedure<
    UsageLoginConfirmationPayload,
    void,
    "main-local"
  >("resolveUsageLoginConfirmation", "main-local", usageLoginConfirmationPayloadSchema),
  getUsageLoginState: definePayloadProcedure<
    UsageLoginStatePayload,
    UsageLoginStateResponse,
    "main-local"
  >("getUsageLoginState", "main-local", usageLoginStatePayloadSchema),
  getProviderUsage: definePayloadProcedure<
    ProviderUsagePayload,
    ProviderUsageResponse,
    "supervisor"
  >("getProviderUsage", "supervisor", providerUsagePayloadSchema),
  refreshProviderUsage: definePayloadProcedure<
    ProviderUsagePayload,
    ProviderUsageResponse,
    "supervisor"
  >("refreshProviderUsage", "supervisor", providerUsagePayloadSchema),
  getUsageHistoryDigest: definePayloadProcedure<
    UsageHistoryDigestPayload,
    UsageHistoryDigest,
    "supervisor"
  >("getUsageHistoryDigest", "supervisor", usageHistoryDigestPayloadSchema),
  getUsageHistoryPage: definePayloadProcedure<
    UsageHistoryPagePayload,
    UsageHistoryPageResponse,
    "supervisor"
  >("getUsageHistoryPage", "supervisor", usageHistoryPagePayloadSchema),
  refreshUsageHistory: definePayloadProcedure<
    RefreshUsageHistoryPayload,
    UsageHistoryDigest,
    "supervisor"
  >("refreshUsageHistory", "supervisor", refreshUsageHistoryPayloadSchema),
} as const;
