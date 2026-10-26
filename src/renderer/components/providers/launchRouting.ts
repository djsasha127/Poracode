import type {
  AgentInstanceConfig,
  AgentStatus,
  ThreadConfig,
  ThreadPresentationMode,
  UsageSnapshot,
} from "@/shared/contracts";
import { baseAgentKind } from "@/shared/contracts";
import {
  resolveAntigravityQuotaFailover,
  type AntigravityQuotaFailoverResult,
} from "./antigravity/quotaFailover";

export interface AgentLaunchRoutingInput {
  agentKind: string;
  config: ThreadConfig;
  presentationMode?: ThreadPresentationMode;
  instances: readonly AgentInstanceConfig[];
  statuses: readonly AgentStatus[];
  snapshots: Readonly<Record<string, UsageSnapshot>>;
}

type AgentLaunchRouter = (input: AgentLaunchRoutingInput) => AntigravityQuotaFailoverResult;

const ROUTERS = new Map<string, AgentLaunchRouter>([
  ["antigravity", resolveAntigravityQuotaFailover],
]);

export function resolveAgentLaunchRoute(
  input: AgentLaunchRoutingInput,
): AntigravityQuotaFailoverResult {
  return ROUTERS.get(baseAgentKind(input.agentKind))?.(input) ?? { agentKind: input.agentKind };
}
