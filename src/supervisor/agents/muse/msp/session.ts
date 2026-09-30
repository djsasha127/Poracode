import type { ChildProcess } from "node:child_process";
import type {
  PromptSegment,
  RuntimeEvent,
  ThreadConfig,
  ThreadServerRequestId,
} from "@/shared/contracts";
import { buildPromptContentBlocks } from "@/shared/promptContent";
import { terminateChildProcessTree } from "@/shared/processTree";
import {
  batchWslCommandsAsync,
  createKnownSessionRef,
  mergeSpawnEnv,
  quotePosixShellArg,
  type CreateStructuredSessionInput,
  type StartTurnOptions,
  type StructuredSessionHandle,
  type StructuredSessionListener,
} from "../../base";
import { resolveAgentBinaryPath } from "../../binaryResolver";
import {
  closePlanAggregator,
  createPlanAggregator,
  replaceAllPlanTasks,
  type PlanStepStatus,
} from "../../planAggregator";
import { buildQuestionAnswerEvents } from "../../questionAnswerEvents";
import { buildMuseServeArgs, toMspApprovalMode } from "./argv";
import {
  aliasMuseMspItem,
  completeOpenMuseMspItems,
  createMuseMspItemMapperState,
  mapMuseMspDelta,
  mapMuseMspGoalChanged,
  mapMuseMspItem,
  type MuseMspItem,
} from "./canonicalMapping";
import { MuseMspClient, spawnMuseServeHost } from "./client";
import {
  MSP_SCHEMA_VERSION,
  MspRpcError,
  parseMspModelListResult,
  type MspModelListResult,
} from "./protocol";
import {
  buildMuseUserInputAnswers,
  isMuseCancelResponse,
  museApprovalRequestType,
  museRequestOutcome,
  readMuseQuestions,
  resolveMuseApprovalChoiceId,
  settledMuseQuestionAnswers,
  type PendingApproval,
  type PendingRequest,
  type PendingUserInput,
} from "./requestMapping";
import { mintMspCommandId } from "./uuidv7";
import { isMuseCompactCommand } from "./localCommands";
import { buildMuseSessionConfig } from "./mcpServers";
import { buildMuseTurnInput } from "./turnInput";
import { msg } from "@/shared/messages";
import { isFullBypassApprovalPolicy } from "@/shared/agents/unrestrictedPermissions";

/**
 * How long the `/compact` turn stays open waiting for the host's `compaction`
 * item. On a real host the item lands a few seconds after the command ack;
 * this is only a safety net so a silent host can never wedge the thread in
 * "working".
 */
const COMPACT_ITEM_TIMEOUT_MS = 30_000;

/** Best-effort budget for the optional `model/list` provider lookup at launch. */
const MSP_PROVIDER_LOOKUP_TIMEOUT_MS = 10_000;

/** Maximum number of durable view events requested in one MSP gap-fill page. */
const MSP_VIEW_PAGE_LIMIT = 1_000;
const MSP_PENDING_REQUEST_RECONCILE_INTERVAL_MS = 2_000;

interface BufferedMuseNotification {
  method: string;
  params: Record<string, unknown>;
}

interface MuseViewGapRecovery {
  readonly nextCursor: string;
  readonly includeNextCursor?: boolean;
  readonly buffered: BufferedMuseNotification[];
}

const NOOP_LISTENER: StructuredSessionListener = {
  onClose() {},
  onError() {},
  onUpdate() {},
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStaleMuseApprovalError(error: unknown): boolean {
  return /approval\s+\S+\s+requirement is stale/i.test(errorMessage(error));
}

function isUnusableMuseResumeSession(error: unknown): boolean {
  const message = errorMessage(error);
  const malformedHistory =
    /classify turns/i.test(message) &&
    /session fork rejected/i.test(message) &&
    /MalformedJsonl/i.test(message);
  const alreadyInUse = /session\s+\S+\s+is already in use/i.test(message);
  const staleMaterializedView =
    /read materialized session view/i.test(message) && /stale sidecar generation/i.test(message);
  return malformedHistory || alreadyInUse || staleMaterializedView;
}

function isMuseSessionNotLoadedError(error: unknown): boolean {
  return /session\s+\S+\s+is not loaded on this host/i.test(errorMessage(error));
}

function isMuseApprovalModeCeilingError(error: unknown): boolean {
  return (
    (error instanceof MspRpcError && error.data?.["reason"] === "approval_mode_ceiling") ||
    /approval mode exceeds or is incomparable with the sealed startup mode/i.test(
      errorMessage(error),
    )
  );
}

function isMuseDuplicateFunctionOutputHistoryError(error: unknown): boolean {
  return (
    /duplicate function_call_output for call_id/i.test(errorMessage(error)) &&
    /each function_call must have exactly one matching function_call_output/i.test(
      errorMessage(error),
    )
  );
}

interface RecoverableMuseTurn {
  turnId: string;
  commandId: string;
  prompt: string;
  config: ThreadConfig;
  segments?: PromptSegment[];
  options?: StartTurnOptions;
  recoveryAttempt: number;
}

function turnState(value: unknown): "completed" | "failed" | "cancelled" {
  if (value === "failed") return "failed";
  if (value === "cancelled") return "cancelled";
  return "completed";
}

function approvalPolicyFromMspMode(
  mode: unknown,
  current: ThreadConfig["approvalPolicy"],
): ThreadConfig["approvalPolicy"] {
  if (mode === "promptUnmatched") return "untrusted";
  if (mode === "onRequest" || mode === "denyUnmatched") return "on-request";
  if (mode === "allowAll") {
    return current === "yolo" || current === "bypassPermissions" ? current : "never";
  }
  return current;
}

/**
 * The choice to take when the app answers an approval itself: a
 * session-scoped approval when the host offers one (it stops re-asking for
 * the same requirement), else a one-shot approval. Returns undefined when the
 * host offered no approving choice — such an approval must reach the user.
 */
function autoApproveChoiceId(choices: readonly Record<string, unknown>[]): string | undefined {
  const pick = (decision: string) =>
    stringValue(choices.find((choice) => choice["decision"] === decision)?.["choiceId"]);
  return pick("approvedForSession") ?? pick("approved");
}

function workspaceRoot(input: CreateStructuredSessionInput): string {
  return input.projectLocation.kind === "wsl"
    ? input.projectLocation.linuxPath
    : input.projectLocation.path;
}

/** Structured Muse Code GUI session backed by the installed `muse serve` MSP host. */
export class MuseMspStructuredSession implements StructuredSessionHandle {
  readonly launchOptions;
  private listener: StructuredSessionListener = NOOP_LISTENER;
  private readonly mapper;
  private readonly planAggregator;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingUserItems = new Map<string, string>();
  private readonly emittedTurnIds = new Set<string>();
  private readonly completedTurnIds = new Set<string>();
  private readonly ownedSessionIds = new Set<string>();
  private readonly autoApprovalsInFlight = new Set<string>();
  private readonly queuedAutoApprovalUpdates = new Map<string, Record<string, unknown>>();
  private bufferedEvents: RuntimeEvent[] = [];
  private currentConfig: ThreadConfig;
  private desiredApprovalPolicy: ThreadConfig["approvalPolicy"];
  private sessionId: string | undefined;
  private sessionDiscoveredAt: string | undefined;
  private activeTurnId: string | undefined;
  private pendingTurnStart: Promise<void> | undefined;
  private resumeAfterUnloadInFlight: Promise<void> | undefined;
  private historyRecoveryInFlight: Promise<void> | undefined;
  private recoverableTurn: RecoverableMuseTurn | undefined;
  private status: "idle" | "working" | "needs_approval" | "needs_reply" | "error" = "idle";
  private attention: "none" | "working" | "needs_approval" | "needs_reply" = "none";
  private activated = false;
  private sessionMcpGranted = false;
  private disposed = false;
  private transportErrorReported = false;
  private transportCloseReported = false;
  private pendingCompact: { turnId: string; timer: NodeJS.Timeout } | undefined;
  private viewGapRecovery: MuseViewGapRecovery | undefined;
  private pendingRequestReconcileTimer: NodeJS.Timeout | undefined;
  private pendingRequestReconcileInFlight = false;
  private lastViewCursor: string | undefined;
  private viewTailReconcileInFlight = false;
  private usageEpoch = 0;
  private usageScopeFresh = false;
  private constructor(
    private readonly input: CreateStructuredSessionInput,
    private readonly child: ChildProcess,
    private readonly client: MuseMspClient,
    private readonly hostCookie: string,
  ) {
    this.launchOptions = {
      suppressResumeConfigOverrides: true,
      ...(input.agentSettings ? { agentSettings: input.agentSettings } : {}),
    };
    this.currentConfig = input.config;
    this.desiredApprovalPolicy = input.config.approvalPolicy;
    this.mapper = createMuseMspItemMapperState(input.threadId);
    this.planAggregator = createPlanAggregator(input.threadId, "muse-plan");
    client.onNotification((method, params) => this.handleNotification(method, params));
    client.onError((error) => this.handleTransportError(error));
    client.onServerRequest(({ method, params }) => this.handleServerRequest(method, params));
    child.once("close", (code, signal) => this.handleTransportClose(code, signal));
    child.once("error", (error) => this.handleTransportError(error));
  }

  static async create(input: CreateStructuredSessionInput): Promise<MuseMspStructuredSession> {
    const executablePath = resolveAgentBinaryPath(input.projectLocation, "muse");
    const extraEnv = mergeSpawnEnv(input.baseSpawnEnv, input.env);
    const hosted = await spawnMuseServeHost(input.projectLocation, {
      ...(executablePath ? { executablePath } : {}),
      serveArgs: buildMuseServeArgs(input.config.approvalPolicy),
      ...(extraEnv ? { extraEnv } : {}),
      label: "[muse-msp]",
      isolateCwd: false,
    });
    return new MuseMspStructuredSession(
      input,
      hosted.child,
      new MuseMspClient(hosted.transport),
      hosted.hostCookie,
    );
  }

  ownsProviderSession(providerSessionId: string): boolean {
    return this.ownedSessionIds.has(providerSessionId);
  }

  setListener(listener: StructuredSessionListener): void {
    this.listener = listener;
    if (listener.onRuntimeEvent && this.bufferedEvents.length > 0) {
      const events = this.bufferedEvents;
      this.bufferedEvents = [];
      for (const event of events) listener.onRuntimeEvent(event);
    }
    this.publishUpdate();
  }

  async activate(): Promise<void> {
    if (this.disposed) throw new Error("Muse MSP session was disposed before activation.");
    const requestedCapabilities = this.input.mcpServers?.length ? ["sessionMcp"] : [];
    const result = await this.client.initialize("poracode", "1.0.0", requestedCapabilities);
    if (result.schema.version !== MSP_SCHEMA_VERSION) {
      throw new Error(
        `Muse MSP schema version ${result.schema.version} is incompatible with supported version ${MSP_SCHEMA_VERSION}.`,
      );
    }
    this.sessionMcpGranted = result.grantedCapabilities.includes("sessionMcp");
    this.activated = true;
  }

  async openThread(config: ThreadConfig, sessionRef = this.input.sessionRef): Promise<string> {
    if (!this.activated) throw new Error("Muse MSP session is not initialized.");
    this.currentConfig = config;
    this.desiredApprovalPolicy = config.approvalPolicy;
    const resumeId = sessionRef?.providerSessionId;
    const resumeCursor = sessionRef?.providerCursor;
    const sessionConfig = this.sessionMcpGranted
      ? buildMuseSessionConfig(this.input.mcpServers)
      : undefined;
    let resumed = Boolean(resumeId);
    let replacedUnusableSession = false;
    let result: Record<string, unknown>;
    try {
      result = resumeId
        ? await this.client.request("session/resume", {
            commandId: mintMspCommandId(),
            sessionId: resumeId,
            excludeItems: true,
            ...(sessionConfig ? { config: sessionConfig } : {}),
          })
        : await this.startFreshSession(config, sessionConfig);
    } catch (error) {
      if (!resumeId || !isUnusableMuseResumeSession(error)) throw error;
      // Muse can reject a provider session because its internal history fork
      // is malformed or because another live client still owns that session.
      // Preserve the Poracode thread and rendered history, but rotate only the
      // unavailable provider session so the same dialogue accepts new turns.
      resumed = false;
      replacedUnusableSession = true;
      result = await this.startFreshSession(config, sessionConfig);
    }
    const session = recordOf(result["session"]);
    const sessionId = stringValue(session?.["sessionId"]);
    if (!sessionId) throw new Error("Muse MSP did not return a session id.");
    this.sessionId = sessionId;
    this.sessionDiscoveredAt = resumed
      ? (sessionRef?.discoveredAt ?? new Date().toISOString())
      : new Date().toISOString();
    const resumedViewHead = await this.resolveCurrentViewHead(
      sessionId,
      stringValue(result["viewCursor"]),
    );
    this.lastViewCursor = resumeCursor ?? resumedViewHead;
    this.ownedSessionIds.add(sessionId);
    this.usageScopeFresh = !resumed;
    this.activeTurnId = stringValue(session?.["activeTurnId"]);
    if (resumed) {
      const approvalMode = recordOf(session?.["approvalMode"]);
      this.currentConfig = {
        ...config,
        model: stringValue(session?.["modelId"]) ?? config.model,
        approvalPolicy: approvalPolicyFromMspMode(approvalMode?.["mode"], config.approvalPolicy),
      };
      await this.applyConfig(config);
      if (resumeCursor && resumedViewHead && resumeCursor !== resumedViewHead) {
        const recovery: MuseViewGapRecovery = {
          nextCursor: resumedViewHead,
          includeNextCursor: true,
          buffered: [],
        };
        this.viewGapRecovery = recovery;
        try {
          await this.fillViewGap(sessionId, resumeCursor, recovery);
          this.finishViewGapRecovery(recovery);
        } catch (error) {
          this.failViewGapRecovery(recovery, error);
        }
      }
    }
    this.refreshWorkingState();
    this.emit({ type: "session.started", threadId: this.input.threadId });
    if (replacedUnusableSession) {
      this.emit({
        type: "warning",
        threadId: this.input.threadId,
        message:
          "Muse could not reopen its previous provider session. Poracode kept this dialogue and started a fresh Muse runtime for subsequent messages.",
      });
    }
    if (session && "goal" in session && session["goal"]) {
      this.emitMany(mapMuseMspGoalChanged(this.mapper, { goal: session["goal"] }));
    }
    if (session && "todoList" in session && session["todoList"]) {
      this.applyTodoListChanged({ todoList: session["todoList"] });
    }
    if (this.activeTurnId) this.emitTurnStarted(this.activeTurnId);
    this.publishUpdate();
    this.startPendingRequestReconciliation();
    return sessionId;
  }

  async startTurn(
    prompt: string,
    config: ThreadConfig,
    segments?: PromptSegment[],
    options?: StartTurnOptions,
  ): Promise<void> {
    const start = this.startTurnRequest(prompt, config, segments, options);
    this.pendingTurnStart = start;
    try {
      await start;
    } finally {
      if (this.pendingTurnStart === start) this.pendingTurnStart = undefined;
    }
  }

  private async startTurnRequest(
    prompt: string,
    config: ThreadConfig,
    segments?: PromptSegment[],
    options?: StartTurnOptions,
    recoveryAttempt = 0,
  ): Promise<void> {
    const sessionId = this.requireSessionId();
    if (isMuseCompactCommand(prompt)) {
      await this.withLoadedSessionRetry(sessionId, () => this.applyConfig(config));
      await this.compactSession(sessionId);
      return;
    }
    const commandId = mintMspCommandId();
    this.pendingUserItems.set(commandId, options?.userMessageItemId ?? `user-${commandId}`);
    this.status = "working";
    this.attention = "working";
    this.publishUpdate();
    try {
      await this.withLoadedSessionRetry(sessionId, () => this.applyConfig(config));
      const input = await buildMuseTurnInput(prompt, options?.inlineInstructions);
      const result = await this.withLoadedSessionRetry(sessionId, () =>
        this.client.request("turn/start", {
          commandId,
          sessionId,
          input,
          displayText: prompt,
          ...(config.effort ? { reasoningEffort: config.effort } : {}),
        }),
      );
      const turnId = stringValue(result["turnId"]) ?? commandId;
      this.recoverableTurn = {
        turnId,
        commandId,
        prompt,
        config,
        ...(segments ? { segments } : {}),
        ...(options ? { options } : {}),
        recoveryAttempt,
      };
      if (result["disposition"] === "started" && !this.completedTurnIds.has(turnId)) {
        this.activeTurnId = turnId;
        this.emitTurnStarted(turnId);
      }
    } catch (error) {
      this.pendingUserItems.delete(commandId);
      // Recovery owns the original lifecycle: its failed provider turn was
      // deliberately suppressed while we rotated the corrupted session. Let
      // the recovery boundary settle that turn once, instead of emitting a
      // second synthetic failed turn for this replacement command id.
      if (recoveryAttempt === 0) this.failTurn(commandId, errorMessage(error));
      throw error;
    }
  }

  /**
   * Muse unloads an idle session after its host retention window while keeping
   * the stdio server alive. The next session-bound request then fails with
   * `not loaded on this host`. Reattach the same durable session and retry the
   * exact operation once; command ids are minted outside this helper so the
   * retry remains idempotent.
   */
  private async withLoadedSessionRetry<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isMuseSessionNotLoadedError(error)) throw error;
      await this.resumeSessionAfterUnload(sessionId);
      return operation();
    }
  }

  private async resumeSessionAfterUnload(sessionId: string): Promise<void> {
    if (this.resumeAfterUnloadInFlight) return this.resumeAfterUnloadInFlight;
    const resume = (async () => {
      const sessionConfig = this.sessionMcpGranted
        ? buildMuseSessionConfig(this.input.mcpServers)
        : undefined;
      const result = await this.client.request("session/resume", {
        commandId: mintMspCommandId(),
        sessionId,
        excludeItems: true,
        ...(sessionConfig ? { config: sessionConfig } : {}),
      });
      const session = recordOf(result["session"]);
      const resumedId = stringValue(session?.["sessionId"]);
      if (resumedId && resumedId !== sessionId) {
        throw new Error(`Muse resumed unexpected session ${resumedId}; expected ${sessionId}.`);
      }
      this.sessionId = sessionId;
      this.ownedSessionIds.add(sessionId);
      this.activeTurnId = stringValue(session?.["activeTurnId"]);
      const head = await this.resolveCurrentViewHead(sessionId, stringValue(result["viewCursor"]));
      // The renderer already owns the durable transcript. Rebase its provider
      // cursor to the reattached host head instead of replaying idle-retention
      // housekeeping as a wall of stale tool activity.
      if (head) this.lastViewCursor = head;
      this.refreshWorkingState();
      this.publishUpdate();
      this.startPendingRequestReconciliation();
    })();
    this.resumeAfterUnloadInFlight = resume;
    try {
      await resume;
    } finally {
      if (this.resumeAfterUnloadInFlight === resume) this.resumeAfterUnloadInFlight = undefined;
    }
  }

  /**
   * `/compact` is a session command, not a turn: the host acknowledges it
   * immediately and streams whatever it produces as ordinary view items, so
   * the session must fall straight back to idle instead of waiting for a
   * `turn/completed` that will never arrive.
   */
  private async compactSession(sessionId: string): Promise<void> {
    const commandId = mintMspCommandId();
    // Run the compaction as a full local turn. Two reasons:
    //  * The submitting renderer paints the thread "working" optimistically and
    //    only a *changed* supervisor thread status clears it, so this path has
    //    to actually leave and re-enter idle — publishing idle from idle is a
    //    no-op that leaves the composer stuck on "Working for Ns" with a Stop
    //    button forever.
    //  * The shared structured-turn queue opens a synthetic turn to carry the
    //    optimistic user message, and only `turn.completed` closes it.
    // `session/compact` reports no host turn of its own (it acks immediately and
    // the `compaction` item lands seconds later, tagged with the PREVIOUS
    // turn's id), so the turn is opened and closed here instead.
    this.activeTurnId = commandId;
    this.status = "working";
    this.attention = "working";
    this.emitTurnStarted(commandId);
    this.publishUpdate();
    try {
      const result = await this.withLoadedSessionRetry(sessionId, () =>
        this.client.request("session/compact", { commandId, sessionId }),
      );
      if (result["status"] === "noop") {
        this.emit({
          type: "warning",
          threadId: this.input.threadId,
          message: stringValue(result["reason"]) ?? msg("thread.compact.noop"),
        });
        this.completeTurn(commandId, "completed");
        return;
      }
      // Accepted: stay working until the compaction item reports completion, so
      // its `item.started` / `item.completed` pair lands *inside* this turn.
      // Trailing item events after `turn.completed` are what re-open a settled
      // GUI turn in the renderer, and nothing would close it a second time.
      this.pendingCompact = {
        turnId: commandId,
        timer: setTimeout(() => {
          this.pendingCompact = undefined;
          this.completeTurn(commandId, "completed");
        }, COMPACT_ITEM_TIMEOUT_MS),
      };
      this.pendingCompact.timer.unref?.();
    } catch (error) {
      this.clearPendingCompact();
      this.failTurn(commandId, errorMessage(error));
      throw error;
    }
  }

  /**
   * Close the compact turn once the host's `compaction` item reaches a terminal
   * state. Called after the item's canonical events are emitted so the item is
   * complete before `turn.completed`.
   */
  private settleCompactItem(item: Record<string, unknown>, phase: string): void {
    const pending = this.pendingCompact;
    if (!pending) return;
    // Only a phase that already closed the item may close the turn. The host
    // sends `item/started` for the compaction with `status: "completed"`
    // already set, but its own `item/completed` still follows — closing the
    // turn on the started phase would put that trailing item event *after*
    // `turn.completed`, which is exactly what re-opens a settled GUI turn.
    const terminal =
      phase === "completed" ||
      (phase === "updated" && (item["status"] === "completed" || item["outcome"] !== undefined));
    if (!terminal) return;
    this.clearPendingCompact();
    this.completeTurn(pending.turnId, "completed");
  }

  private clearPendingCompact(): void {
    if (!this.pendingCompact) return;
    clearTimeout(this.pendingCompact.timer);
    this.pendingCompact = undefined;
  }

  /**
   * Enqueue input onto the running turn. `turn/steer` carries no `displayText`
   * (unlike `turn/start`), so the steered prompt only reaches the transcript
   * through the server's `userMessage` echo — and registering the optimistic
   * alias below makes the mapper suppress that echo's `item.started`. Paint the
   * row here, before the round-trip, so the message is visible immediately and
   * survives a wedged or silent provider turn. The id stays stable across the
   * `startTurn` fallbacks so the re-emitted row is deduped, not duplicated.
   */
  async steerTurn(
    prompt: string,
    config: ThreadConfig,
    segments?: PromptSegment[],
    options?: StartTurnOptions,
  ): Promise<void> {
    const userItemId = options?.userMessageItemId ?? `user-${mintMspCommandId()}`;
    const steerOptions: StartTurnOptions = { ...options, userMessageItemId: userItemId };
    if (prompt.length > 0) {
      this.emitMany([
        {
          type: "item.started",
          threadId: this.input.threadId,
          itemId: userItemId,
          itemType: "user_message",
          payload: { content: buildPromptContentBlocks(prompt, segments) },
        },
        { type: "item.completed", threadId: this.input.threadId, itemId: userItemId },
      ]);
    }
    for (;;) {
      if (!this.activeTurnId && this.pendingTurnStart) await this.pendingTurnStart;
      if (!this.activeTurnId) return this.startTurn(prompt, config, segments, steerOptions);
      const expectedTurnId = this.activeTurnId;
      await this.applyConfig(config);
      const commandId = mintMspCommandId();
      this.pendingUserItems.set(commandId, userItemId);
      try {
        await this.client.request("turn/steer", {
          commandId,
          sessionId: this.requireSessionId(),
          expectedTurnId,
          input: await buildMuseTurnInput(prompt, options?.inlineInstructions),
          ...(config.effort ? { reasoningEffort: config.effort } : {}),
        });
        return;
      } catch (error) {
        this.pendingUserItems.delete(commandId);
        if (error instanceof MspRpcError && error.kind === "commandRejected") {
          if (this.activeTurnId && this.activeTurnId !== expectedTurnId) {
            continue;
          }
          if (this.activeTurnId === expectedTurnId) this.activeTurnId = undefined;
          await this.startTurn(prompt, config, segments, steerOptions);
          return;
        }
        throw error;
      }
    }
  }

  async interruptTurn(): Promise<void> {
    if (!this.sessionId || this.disposed || !this.activeTurnId) return;
    // The compact turn is local — the host knows no turn by that id and would
    // reject `turn/interrupt`. Stop just closes it.
    if (this.pendingCompact?.turnId === this.activeTurnId) {
      const turnId = this.pendingCompact.turnId;
      this.clearPendingCompact();
      this.completeTurn(turnId, "cancelled");
      return;
    }
    await this.client.request("turn/interrupt", {
      commandId: mintMspCommandId(),
      sessionId: this.sessionId,
      turnId: this.activeTurnId,
      retract: false,
    });
  }

  forceCompleteTurn(): void {
    if (!this.activeTurnId) return;
    this.completeTurn(this.activeTurnId, "cancelled");
  }

  async resolveServerRequest(requestId: ThreadServerRequestId, response: unknown): Promise<void> {
    const id = String(requestId);
    const pending = this.pendingRequests.get(id);
    if (!pending) throw new Error(`Muse MSP request ${id} is no longer pending.`);
    if (pending.kind === "approval") {
      try {
        await this.resolveApproval(pending, response);
      } catch (error) {
        // A multi-stage approval can advance between rendering and the user's
        // click. Treat the old requirement as superseded, close its card, and
        // immediately pull the authoritative current stage from Muse.
        if (!isStaleMuseApprovalError(error)) throw error;
        this.resolveRequestFromNotification(id, "cancelled");
        await this.reconcilePendingRequests();
      }
      return;
    }
    await this.resolveUserInput(pending, response);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPendingCompact();
    this.stopPendingRequestReconciliation();
    this.emitMany(closePlanAggregator(this.planAggregator));
    for (const requestId of this.pendingRequests.keys()) {
      this.emit({
        type: "request.resolved",
        threadId: this.input.threadId,
        requestId,
        outcome: "cancelled",
      });
    }
    this.pendingRequests.clear();
    if (this.activeTurnId) this.completeTurn(this.activeTurnId, "cancelled");
    this.client.dispose();
    terminateChildProcessTree(this.child, { ownedProcessGroup: process.platform !== "win32" });
    this.killSurvivingWslHost();
    this.emit({ type: "session.exited", threadId: this.input.threadId, reason: "disposed" });
    this.listener.onClose();
  }

  /**
   * Terminating the Windows-side `wsl.exe` wrapper cannot be relied on to
   * signal the Linux-side `muse serve` it launched — a surviving host keeps
   * its sessions locked (`session/resume` then fails `sessionInUse` forever)
   * and leaks CPU. The host carries a unique cookie in its environ; sweep
   * /proc for it and kill what matches. Best-effort: the bridge may be gone
   * (app teardown) or the process may already be dead.
   */
  private killSurvivingWslHost(): void {
    const location = this.input.projectLocation;
    if (location.kind !== "wsl") return;
    void batchWslCommandsAsync(location.distro, [
      `pids=$(grep -ls ${quotePosixShellArg(this.hostCookie)} /proc/[0-9]*/environ 2>/dev/null | tr -dc '0-9\\n '); [ -n "$pids" ] && kill -9 $pids 2>/dev/null; true`,
    ]).catch(() => {});
  }

  private requireSessionId(): string {
    if (this.disposed) throw new Error("Muse MSP session is closed.");
    if (!this.sessionId) throw new Error("Muse MSP session is not open.");
    return this.sessionId;
  }

  /**
   * The model catalog's provider route for the requested model. The CLI always
   * routes through this table, but `session/start` without `providerId` falls
   * back to the server default — a different route whose retained-history
   * policy rejects media ("retained media history is unsupported"), so as soon
   * as the agent reads an attached image the whole turn fails. Best-effort:
   * when the catalog is unavailable, omit the field and keep the server
   * default. Short timeout — this lookup is optional and must not stall the
   * launch when the host is wedged.
   */
  private async resolveModelProviderId(modelId: string): Promise<Record<string, string>> {
    try {
      const catalog = parseMspModelListResult(
        await this.client.request("model/list", {}, MSP_PROVIDER_LOOKUP_TIMEOUT_MS),
      );
      const providerId = this.catalogProviderId(catalog, modelId);
      return providerId ? { providerId } : {};
    } catch {
      return {};
    }
  }

  /** Catalog route for a model: its own entry's provider, else the catalog default. */
  private catalogProviderId(catalog: MspModelListResult, modelId: string): string {
    return (
      catalog.models.find((model) => model.modelId === modelId)?.providerId || catalog.providerId
    );
  }

  /**
   * Enterprise/local Muse policy can seal a host to `promptUnmatched` even
   * when the Poracode thread asks for `onRequest` or bypass. Muse rejects the
   * whole session with `approval_mode_ceiling` in that case. Retry once with
   * its strictest mode: Poracode still owns the user's desired policy — bypass
   * threads auto-decide the resulting approvals, while ordinary threads keep
   * surfacing them — so Crossagents remains usable without weakening safety.
   */
  private async startFreshSession(
    config: ThreadConfig,
    sessionConfig: ReturnType<typeof buildMuseSessionConfig>,
  ): Promise<Record<string, unknown>> {
    const provider = await this.resolveModelProviderId(config.model);
    const start = (approvalMode: ReturnType<typeof toMspApprovalMode>) =>
      this.client.request("session/start", {
        commandId: mintMspCommandId(),
        workspaceRoot: workspaceRoot(this.input),
        modelId: config.model,
        ...provider,
        approvalMode,
        ...(sessionConfig ? { config: sessionConfig } : {}),
      });
    const requestedMode = toMspApprovalMode(config.approvalPolicy);
    try {
      return await start(requestedMode);
    } catch (error) {
      if (requestedMode === "promptUnmatched" || !isMuseApprovalModeCeilingError(error)) {
        throw error;
      }
      return start("promptUnmatched");
    }
  }

  private async applyConfig(config: ThreadConfig): Promise<void> {
    const sessionId = this.requireSessionId();
    // Keep the UI-selected policy separate from provider echoes. A resumed
    // Muse session can publish its old approval mode after reconciliation;
    // that stale echo must not silently disable Poracode's bypass behavior.
    this.desiredApprovalPolicy = config.approvalPolicy;
    if (config.model !== this.currentConfig.model) {
      const catalog = parseMspModelListResult(
        await this.client.request("model/list", { sessionId }),
      );
      const providerId = this.catalogProviderId(catalog, config.model);
      await this.client.request("session/setModel", {
        commandId: mintMspCommandId(),
        sessionId,
        model: {
          modelId: config.model,
          ...(providerId ? { providerId } : {}),
          ...(catalog.profileId ? { profileId: catalog.profileId } : {}),
        },
      });
    }
    if (config.approvalPolicy !== this.currentConfig.approvalPolicy) {
      const requestedMode = toMspApprovalMode(config.approvalPolicy);
      const setMode = (mode: ReturnType<typeof toMspApprovalMode>) =>
        this.client.request("session/setApprovalMode", {
          commandId: mintMspCommandId(),
          sessionId,
          mode,
        });
      try {
        await setMode(requestedMode);
      } catch (error) {
        if (requestedMode === "promptUnmatched" || !isMuseApprovalModeCeilingError(error)) {
          throw error;
        }
        await setMode("promptUnmatched");
      }
    }
    this.currentConfig = config;
    this.publishUpdate();
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (this.disposed || (this.sessionId && params["sessionId"] !== this.sessionId)) return;
    if (method === "view/gap") {
      if (this.viewGapRecovery) {
        this.viewGapRecovery.buffered.push({ method, params });
      } else {
        this.startViewGapRecovery(params);
      }
      return;
    }
    if (this.viewGapRecovery) {
      this.viewGapRecovery.buffered.push({ method, params });
      return;
    }
    this.applyNotification(method, params);
  }

  private applyNotification(
    method: string,
    params: Record<string, unknown>,
    options?: { replayed?: boolean },
  ): void {
    const previousCursor = this.lastViewCursor;
    this.lastViewCursor = stringValue(params["viewCursor"]) ?? this.lastViewCursor;
    const cursorChanged = this.lastViewCursor !== previousCursor;
    switch (method) {
      case "turn/started": {
        const turnId = stringValue(params["turnId"]);
        if (!turnId) return;
        // A forward page can contain an older completed turn before the live
        // turn we are recovering. Keep its canonical lifecycle event, but do
        // not let historical replay replace the host-confirmed active turn.
        if (options?.replayed && this.activeTurnId && this.activeTurnId !== turnId) {
          this.emitTurnStarted(turnId);
          return;
        }
        this.activeTurnId = turnId;
        this.status = "working";
        this.attention = "working";
        this.emitTurnStarted(turnId);
        this.publishUpdate();
        return;
      }
      case "turn/completed": {
        const turnId = stringValue(params["turnId"]);
        if (!turnId) return;
        const state = turnState(params["terminal"]);
        const settlesLiveTurn =
          !options?.replayed || (this.activeTurnId !== undefined && this.activeTurnId === turnId);
        if (state === "failed" && settlesLiveTurn) {
          const error = recordOf(params["error"]);
          const message = stringValue(error?.["message"]) ?? stringValue(params["reason"]);
          const recoverable = this.recoverableTurn;
          if (
            message &&
            recoverable?.turnId === turnId &&
            recoverable.recoveryAttempt === 0 &&
            !this.historyRecoveryInFlight &&
            isMuseDuplicateFunctionOutputHistoryError(message)
          ) {
            this.completedTurnIds.add(turnId);
            this.emitMany(completeOpenMuseMspItems(this.mapper));
            this.historyRecoveryInFlight = this.recoverDuplicateFunctionOutput(
              recoverable,
              message,
            );
            return;
          }
          if (message) this.emit({ type: "error", threadId: this.input.threadId, message });
        }
        if (this.recoverableTurn?.turnId === turnId) this.recoverableTurn = undefined;
        this.completeTurn(turnId, state, { preserveSessionState: !settlesLiveTurn });
        return;
      }
      case "item/started":
      case "item/updated":
      case "item/completed": {
        const item = recordOf(params["item"]);
        if (!item) return;
        const childSessionId = stringValue(item["childSessionId"]);
        if (childSessionId) this.ownedSessionIds.add(childSessionId);
        const providerItemId = stringValue(item["itemId"]);
        const commandId = stringValue(item["commandId"]);
        const optimisticId = commandId ? this.pendingUserItems.get(commandId) : undefined;
        if (providerItemId && optimisticId) {
          aliasMuseMspItem(this.mapper, providerItemId, optimisticId);
          this.pendingUserItems.delete(commandId!);
        }
        const phase =
          method === "item/started"
            ? "started"
            : method === "item/updated"
              ? "updated"
              : "completed";
        this.emitMany(mapMuseMspItem(this.mapper, item as MuseMspItem, phase));
        if (stringValue(item["kind"]) === "compaction") this.settleCompactItem(item, phase);
        if (cursorChanged) this.publishUpdate();
        return;
      }
      case "item/delta":
        this.emitMany(mapMuseMspDelta(this.mapper, params));
        return;
      case "approval/requested":
      case "approval/updated":
        this.openApproval(params);
        return;
      case "approval/resolved":
        this.resolveRequestFromNotification(stringValue(params["approvalId"]), params["decision"]);
        return;
      case "userInput/requested":
        this.openUserInput(params);
        return;
      case "userInput/settled":
        this.resolveRequestFromNotification(
          stringValue(params["userInputId"]),
          params["outcome"],
          params,
        );
        return;
      case "session/contextUsage": {
        const usedTokens = numberValue(params["usedTokens"]);
        const maxTokens = numberValue(params["windowTokens"]);
        if (usedTokens === undefined && maxTokens === undefined) return;
        this.emit({
          type: "context.updated",
          threadId: this.input.threadId,
          usage: {
            ...(usedTokens !== undefined ? { usedTokens } : {}),
            ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
          },
        });
        return;
      }
      case "session/tokenUsage":
        this.handleUsage(params);
        return;
      case "session/modelChanged": {
        const model = recordOf(params["model"]);
        const modelId = stringValue(model?.["modelId"]) ?? stringValue(params["modelId"]);
        if (modelId) this.currentConfig = { ...this.currentConfig, model: modelId };
        this.publishUpdate();
        return;
      }
      case "session/approvalModeChanged":
        if (
          isFullBypassApprovalPolicy(this.desiredApprovalPolicy) &&
          params["mode"] !== "allowAll"
        ) {
          this.currentConfig = {
            ...this.currentConfig,
            approvalPolicy: this.desiredApprovalPolicy,
          };
          this.publishUpdate();
          return;
        }
        this.currentConfig = {
          ...this.currentConfig,
          approvalPolicy: approvalPolicyFromMspMode(
            params["mode"],
            this.currentConfig.approvalPolicy,
          ),
        };
        this.publishUpdate();
        return;
      case "session/goalChanged":
        this.emitMany(mapMuseMspGoalChanged(this.mapper, params));
        return;
      case "session/todoListChanged": {
        this.applyTodoListChanged(params);
        return;
      }
    }
  }

  /**
   * Muse can persist a compaction checkpoint whose projected history contains
   * the same tool result twice. Every later model request then fails before it
   * can do new work. Keep Poracode's transcript, rotate only the corrupted Muse
   * provider session, and retry the user's current message once.
   */
  private async recoverDuplicateFunctionOutput(
    turn: RecoverableMuseTurn,
    originalError: string,
  ): Promise<void> {
    try {
      this.pendingUserItems.delete(turn.commandId);
      this.recoverableTurn = undefined;
      this.activeTurnId = undefined;
      this.status = "working";
      this.attention = "working";
      const sessionConfig = this.sessionMcpGranted
        ? buildMuseSessionConfig(this.input.mcpServers)
        : undefined;
      const result = await this.startFreshSession(turn.config, sessionConfig);
      const session = recordOf(result["session"]);
      const sessionId = stringValue(session?.["sessionId"]);
      if (!sessionId) throw new Error("Muse MSP did not return a replacement session id.");
      this.sessionId = sessionId;
      this.sessionDiscoveredAt = new Date().toISOString();
      this.lastViewCursor = await this.resolveCurrentViewHead(
        sessionId,
        stringValue(result["viewCursor"]),
      );
      this.ownedSessionIds.add(sessionId);
      this.currentConfig = turn.config;
      this.desiredApprovalPolicy = turn.config.approvalPolicy;
      this.usageEpoch += 1;
      this.usageScopeFresh = true;
      this.publishUpdate();
      await this.startTurnRequest(
        turn.prompt,
        turn.config,
        turn.segments,
        turn.options,
        turn.recoveryAttempt + 1,
      );
    } catch {
      this.recoverableTurn = undefined;
      this.emit({ type: "error", threadId: this.input.threadId, message: originalError });
      this.completedTurnIds.delete(turn.turnId);
      this.completeTurn(turn.turnId, "failed");
    } finally {
      this.historyRecoveryInFlight = undefined;
    }
  }

  /**
   * MSP push delivery is explicitly lossy under backpressure. `view/gap`
   * brackets the missing durable events, and `view/page` is the protocol's
   * sanctioned splice-fill path. Keep subsequent live notifications buffered
   * until the missing range has been replayed so an assistant message and its
   * terminal event cannot arrive out of order or leave the GUI stuck working.
   */
  private startViewGapRecovery(params: Record<string, unknown>): void {
    const sessionId = stringValue(params["sessionId"]);
    const afterCursor = stringValue(params["after"]);
    const nextCursor = stringValue(params["next"]);
    if (!sessionId || !afterCursor || !nextCursor || sessionId !== this.sessionId) return;

    const recovery: MuseViewGapRecovery = { nextCursor, buffered: [] };
    this.viewGapRecovery = recovery;
    void this.fillViewGap(sessionId, afterCursor, recovery)
      .then(() => this.finishViewGapRecovery(recovery))
      .catch((error) => this.failViewGapRecovery(recovery, error));
  }

  private async fillViewGap(
    sessionId: string,
    afterCursor: string,
    recovery: MuseViewGapRecovery,
  ): Promise<void> {
    let cursor = afterCursor;
    for (;;) {
      const result = await this.client.request("view/page", {
        sessionId,
        cursor,
        direction: "forward",
        limit: MSP_VIEW_PAGE_LIMIT,
      });
      const events = Array.isArray(result["events"]) ? result["events"] : [];
      for (const rawEvent of events) {
        const event = recordOf(rawEvent);
        const method = stringValue(event?.["method"]);
        const eventParams = recordOf(event?.["params"]);
        if (!method || !eventParams) continue;
        if (stringValue(eventParams["viewCursor"]) === recovery.nextCursor) {
          if (recovery.includeNextCursor) {
            this.applyNotification(method, eventParams, { replayed: true });
          }
          return;
        }
        this.applyNotification(method, eventParams, { replayed: true });
      }

      const nextPageCursor = stringValue(result["nextCursor"]);
      if (!nextPageCursor) {
        // `view/page` contains durable notifications only, while a gap's
        // upper cursor (and `session/read.viewCursor`) may name an ephemeral
        // notification such as a streaming delta. Reaching the durable end
        // therefore means every recoverable event was replayed even when the
        // exact opaque upper cursor was not present in the page. Re-anchor to
        // that observed live cursor so reconnects do not retry the same
        // already-drained range forever.
        this.lastViewCursor = recovery.nextCursor;
        return;
      }
      if (nextPageCursor === cursor) {
        throw new Error("Muse MSP view gap paging did not advance.");
      }
      cursor = nextPageCursor;
    }
  }

  private finishViewGapRecovery(recovery: MuseViewGapRecovery): void {
    if (this.disposed || this.viewGapRecovery !== recovery) return;
    this.viewGapRecovery = undefined;
    this.drainBufferedNotifications(recovery.buffered);
  }

  private failViewGapRecovery(recovery: MuseViewGapRecovery, error: unknown): void {
    if (this.disposed || this.viewGapRecovery !== recovery) return;
    this.viewGapRecovery = undefined;
    // History replay is a repair path around an already-live provider
    // session. A stale/pruned cursor or a transient page failure must not mark
    // that live turn as failed: Muse can continue producing notifications and
    // the renderer already owns the transcript up to its persisted cursor.
    // Re-anchor to the host-observed upper cursor and keep consuming live
    // events. Surface the loss as a warning so it remains diagnosable without
    // turning a healthy provider process red.
    this.lastViewCursor = recovery.nextCursor;
    this.emit({
      type: "warning",
      threadId: this.input.threadId,
      message: `Muse MSP skipped an unavailable history range and re-anchored to the live session: ${errorMessage(error)}`,
    });
    this.drainBufferedNotifications(recovery.buffered);
    if (!this.viewGapRecovery) this.resumeWorkingState();
  }

  private drainBufferedNotifications(notifications: readonly BufferedMuseNotification[]): void {
    for (let index = 0; index < notifications.length; index += 1) {
      const notification = notifications[index]!;
      this.handleNotification(notification.method, notification.params);
      if (this.viewGapRecovery) {
        this.viewGapRecovery.buffered.push(...notifications.slice(index + 1));
        return;
      }
    }
  }

  private applyTodoListChanged(params: Record<string, unknown>): void {
    const rawItems = params["items"] ?? (recordOf(params["todoList"])?.["items"] as unknown);
    const items = Array.isArray(rawItems) ? rawItems : [];
    const tasks = items.map((raw, index) => {
      const item = recordOf(raw);
      let text =
        stringValue(item?.["activeForm"]) ?? stringValue(item?.["text"]) ?? `Task ${index + 1}`;
      const statusRaw = stringValue(item?.["status"]);
      // The plan dock has no cancelled state — a cancelled todo is done-not-done,
      // so it lands on "completed" with the cancellation kept in the label.
      const cancelled = statusRaw === "cancelled";
      if (cancelled) text = `${text} (cancelled)`;
      const status: PlanStepStatus = cancelled
        ? "completed"
        : statusRaw === "inProgress" || statusRaw === "in_progress"
          ? "in_progress"
          : statusRaw === "completed"
            ? "completed"
            : "pending";
      return { key: `task-${index}`, description: text, status };
    });
    this.emitMany(replaceAllPlanTasks(this.planAggregator, tasks));
  }

  private handleServerRequest(
    method: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    if (method === "approval/request") {
      if (!this.pendingRequests.has(stringValue(params["approvalId"]) ?? "")) {
        this.openApproval(params);
      }
      return {};
    }
    if (method === "userInput/request") {
      if (!this.pendingRequests.has(stringValue(params["userInputId"]) ?? "")) {
        this.openUserInput(params);
      }
      return {};
    }
    throw new Error(`Unsupported Muse MSP server request: ${method}`);
  }

  private emitTurnStarted(turnId: string): void {
    if (this.emittedTurnIds.has(turnId)) return;
    this.emittedTurnIds.add(turnId);
    this.emit({ type: "turn.started", threadId: this.input.threadId, turnId });
  }

  private completeTurn(
    turnId: string,
    state: "completed" | "failed" | "cancelled",
    options?: { preserveSessionState?: boolean },
  ): void {
    if (this.completedTurnIds.has(turnId)) return;
    this.completedTurnIds.add(turnId);
    this.emitTurnStarted(turnId);
    this.emitMany(completeOpenMuseMspItems(this.mapper));
    this.emit({ type: "turn.completed", threadId: this.input.threadId, turnId, state });
    if (options?.preserveSessionState) return;
    if (this.activeTurnId === turnId) this.activeTurnId = undefined;
    this.status = state === "failed" ? "error" : "idle";
    this.attention = "none";
    this.publishUpdate();
  }

  private failTurn(turnId: string, message: string): void {
    this.emit({ type: "error", threadId: this.input.threadId, message });
    this.completeTurn(turnId, "failed");
  }

  private openApproval(params: Record<string, unknown>, allowAutoApprove = true): void {
    const approvalId = stringValue(params["approvalId"]);
    const requirementId = recordOf(params["currentRequirementId"]);
    const choices = Array.isArray(params["availableChoices"])
      ? params["availableChoices"].flatMap((choice) =>
          recordOf(choice) ? [recordOf(choice)!] : [],
        )
      : [];
    if (!approvalId || !requirementId || choices.length === 0) return;
    // Verified against `muse` 1.0.3: even with the session in `allowAll`
    // approval mode, the host still raises an approval for shell pipelines it
    // cannot statically parse (heredocs, `… | head`, … — the subject arrives
    // with an empty `stages` list). `muse serve` has no `--disable-approval`
    // switch, so under a full-bypass policy the only way to honour "never ask"
    // is to decide on the user's behalf. Ask-style policies are untouched.
    if (this.autoApprovalsInFlight.has(approvalId)) {
      // Muse may publish the next requirement before the previous decide RPC
      // settles. Preserve that update so bypass mode can continue through the
      // full pipeline instead of retaining a stale requirement forever.
      this.queuedAutoApprovalUpdates.set(approvalId, params);
      return;
    }
    if (allowAutoApprove && isFullBypassApprovalPolicy(this.desiredApprovalPolicy)) {
      const autoChoiceId = autoApproveChoiceId(choices);
      if (autoChoiceId) {
        this.autoApprovalsInFlight.add(approvalId);
        this.autoDecideApproval(approvalId, requirementId, autoChoiceId, params);
        return;
      }
    }
    this.pendingRequests.set(approvalId, { kind: "approval", approvalId, requirementId, choices });
    const subject = recordOf(params["subject"]);
    const toolName =
      stringValue(params["toolName"]) ?? stringValue(subject?.["toolName"]) ?? "Tool";
    this.emit({
      type: "request.opened",
      threadId: this.input.threadId,
      requestId: approvalId,
      requestType: museApprovalRequestType(subject),
      payload: {
        summary: stringValue(subject?.["command"]) ?? stringValue(subject?.["path"]) ?? toolName,
        details: {
          toolName,
          displayName: toolName,
          input: subject ?? params["rawArgs"],
          toolUseID: stringValue(params["toolCallId"]),
        },
        options: choices.flatMap((choice) => {
          const id = stringValue(choice["choiceId"]);
          const label = stringValue(choice["label"]);
          return id && label ? [{ optionId: id, label }] : [];
        }),
      },
    });
    this.resumeWorkingState();
  }

  /**
   * MSP push delivery can omit an approval/request while the durable session
   * still waits for it. Reconcile against the protocol's authoritative pull
   * view so a missed push cannot leave an active turn stuck forever.
   */
  private startPendingRequestReconciliation(): void {
    if (this.pendingRequestReconcileTimer || this.disposed) return;
    void this.reconcilePendingRequests();
    void this.reconcileViewTail();
    this.pendingRequestReconcileTimer = setInterval(() => {
      void this.reconcilePendingRequests();
      void this.reconcileViewTail();
    }, MSP_PENDING_REQUEST_RECONCILE_INTERVAL_MS);
    this.pendingRequestReconcileTimer.unref?.();
  }

  private stopPendingRequestReconciliation(): void {
    if (!this.pendingRequestReconcileTimer) return;
    clearInterval(this.pendingRequestReconcileTimer);
    this.pendingRequestReconcileTimer = undefined;
  }

  private async reconcilePendingRequests(): Promise<void> {
    if (this.disposed || !this.sessionId || this.pendingRequestReconcileInFlight) return;
    this.pendingRequestReconcileInFlight = true;
    try {
      const result = await this.client.request("approval/listPending", {
        sessionId: this.sessionId,
      });
      const approvals = Array.isArray(result["approvals"]) ? result["approvals"] : [];
      for (const rawApproval of approvals) {
        const approval = recordOf(rawApproval);
        if (approval) this.openApproval(approval);
      }
      const userInputs = Array.isArray(result["userInputs"]) ? result["userInputs"] : [];
      for (const rawUserInput of userInputs) {
        const userInput = recordOf(rawUserInput);
        if (userInput) this.openUserInput(userInput);
      }
    } catch {
      // This is a watchdog for a lossy push path. A transient pull failure must
      // not fail the live turn; the next bounded interval retries it.
    } finally {
      this.pendingRequestReconcileInFlight = false;
    }
  }

  /**
   * A lossy MSP connection can drop the final events without emitting a later
   * `view/gap`, leaving the UI "working" after Muse has durably completed.
   * While a turn is active, compare our last observed cursor with a read-only
   * snapshot head and splice any missing suffix through the same ordered view
   * recovery path used for explicit gaps.
   */
  private async reconcileViewTail(): Promise<void> {
    if (
      this.disposed ||
      !this.sessionId ||
      !this.activeTurnId ||
      !this.lastViewCursor ||
      this.viewGapRecovery ||
      this.viewTailReconcileInFlight
    ) {
      return;
    }
    const sessionId = this.sessionId;
    const afterCursor = this.lastViewCursor;
    this.viewTailReconcileInFlight = true;
    try {
      const snapshot = await this.client.request("session/read", {
        sessionId,
        excludeItems: true,
      });
      const snapshotSession = recordOf(snapshot["session"]);
      const hostIsIdle =
        snapshotSession?.["status"] === "idle" &&
        stringValue(snapshotSession["activeTurnId"]) === undefined;
      const headCursor = await this.resolveCurrentViewHead(
        sessionId,
        stringValue(snapshot["viewCursor"]),
      );
      if (
        !headCursor ||
        headCursor === afterCursor ||
        this.lastViewCursor !== afterCursor ||
        this.viewGapRecovery
      ) {
        if (hostIsIdle && this.activeTurnId) this.completeTurn(this.activeTurnId, "completed");
        return;
      }
      const recovery: MuseViewGapRecovery = {
        nextCursor: headCursor,
        includeNextCursor: true,
        buffered: [],
      };
      this.viewGapRecovery = recovery;
      try {
        await this.fillViewGap(sessionId, afterCursor, recovery);
        this.finishViewGapRecovery(recovery);
        if (hostIsIdle && this.activeTurnId) this.completeTurn(this.activeTurnId, "completed");
      } catch (error) {
        this.failViewGapRecovery(recovery, error);
      }
    } catch {
      // A transient snapshot failure is non-terminal; the next watchdog tick
      // retries while the turn still appears active.
    } finally {
      this.viewTailReconcileInFlight = false;
    }
  }

  /**
   * Muse 1.0.3 can return an empty `session/read.viewCursor` when its folded
   * projection is unavailable even though the durable view is pageable. Use
   * the final event of a one-row backward page as the authoritative head.
   */
  private async resolveCurrentViewHead(
    sessionId: string,
    hintedCursor: string | undefined,
  ): Promise<string | undefined> {
    if (hintedCursor) return hintedCursor;
    const page = await this.client.request("view/page", {
      sessionId,
      direction: "backward",
      limit: 1,
    });
    const events = Array.isArray(page["events"]) ? page["events"] : [];
    const latestEvent = recordOf(events.at(-1));
    return stringValue(recordOf(latestEvent?.["params"])?.["viewCursor"]);
  }

  /**
   * Answer an approval on the user's behalf without ever surfacing it. Runs
   * from a notification/server-request handler, so failures are reported on
   * the session error channel rather than thrown.
   */
  private autoDecideApproval(
    approvalId: string,
    requirementId: Record<string, unknown>,
    choiceId: string,
    originalParams: Record<string, unknown>,
  ): void {
    const surfaceAfterFailure = (error: unknown) => {
      this.autoApprovalsInFlight.delete(approvalId);
      this.emit({ type: "error", threadId: this.input.threadId, message: errorMessage(error) });
      const latestParams = this.queuedAutoApprovalUpdates.get(approvalId) ?? originalParams;
      this.queuedAutoApprovalUpdates.delete(approvalId);
      if (!this.disposed) this.openApproval(latestParams, false);
    };
    let sessionId: string;
    try {
      sessionId = this.requireSessionId();
    } catch (error) {
      surfaceAfterFailure(error);
      return;
    }
    void this.client
      .request("approval/decide", {
        commandId: mintMspCommandId(),
        sessionId,
        approvalId,
        requirementId,
        choiceId,
      })
      .then(() => {
        this.autoApprovalsInFlight.delete(approvalId);
        const nextParams = this.queuedAutoApprovalUpdates.get(approvalId);
        this.queuedAutoApprovalUpdates.delete(approvalId);
        if (nextParams && !this.disposed) this.openApproval(nextParams);
      })
      .catch(surfaceAfterFailure);
  }

  private openUserInput(params: Record<string, unknown>): void {
    const userInputId = stringValue(params["userInputId"]);
    const questions = readMuseQuestions(params);
    if (!userInputId || questions.length === 0) return;
    this.pendingRequests.set(userInputId, { kind: "userInput", userInputId, questions });
    this.emit({
      type: "request.opened",
      threadId: this.input.threadId,
      requestId: userInputId,
      requestType: "tool_user_input",
      payload: {
        summary: questions[0]!.question,
        details: {
          userInputForm: {
            questions: questions.map((question) => ({
              id: question.id,
              header: question.header,
              question: question.question,
              multiSelect: question.multiSelect,
              options: question.options,
            })),
          },
        },
      },
    });
    this.resumeWorkingState();
  }

  private async resolveApproval(pending: PendingApproval, response: unknown): Promise<void> {
    const choiceId = resolveMuseApprovalChoiceId(pending, response);
    if (!choiceId) throw new Error("Muse MSP approval supplied no usable choice.");
    await this.client.request("approval/decide", {
      commandId: mintMspCommandId(),
      sessionId: this.requireSessionId(),
      approvalId: pending.approvalId,
      requirementId: pending.requirementId,
      choiceId,
    });
  }

  private async resolveUserInput(pending: PendingUserInput, response: unknown): Promise<void> {
    if (isMuseCancelResponse(response)) {
      await this.client.request("userInput/cancel", {
        commandId: mintMspCommandId(),
        sessionId: this.requireSessionId(),
        userInputId: pending.userInputId,
        reason: "User cancelled the request.",
      });
      return;
    }
    const answers = buildMuseUserInputAnswers(response, pending.questions);
    await this.client.request("userInput/answer", {
      commandId: mintMspCommandId(),
      sessionId: this.requireSessionId(),
      userInputId: pending.userInputId,
      answers,
    });
  }

  private resolveRequestFromNotification(
    requestId: string | undefined,
    outcome: unknown,
    params?: Record<string, unknown>,
  ): void {
    if (!requestId) return;
    this.autoApprovalsInFlight.delete(requestId);
    this.queuedAutoApprovalUpdates.delete(requestId);
    const pending = this.pendingRequests.get(requestId);
    if (!pending || !this.pendingRequests.delete(requestId)) return;
    this.emit({
      type: "request.resolved",
      threadId: this.input.threadId,
      requestId,
      outcome: museRequestOutcome(outcome),
    });
    if (pending.kind === "userInput" && outcome === "answered") {
      this.emitMany(
        buildQuestionAnswerEvents({
          threadId: this.input.threadId,
          itemId: `muse-question-${mintMspCommandId()}`,
          questions: pending.questions.map((question) => ({
            keys: [question.id, question.question],
            header: question.header,
            question: question.question,
            options: question.options,
          })),
          answers: settledMuseQuestionAnswers(params?.["answers"]),
        }),
      );
    }
    this.resumeWorkingState();
  }

  private refreshWorkingState(): void {
    const requests = [...this.pendingRequests.values()];
    if (requests.some((request) => request.kind === "userInput")) {
      this.status = "needs_reply";
      this.attention = "needs_reply";
    } else if (requests.some((request) => request.kind === "approval")) {
      this.status = "needs_approval";
      this.attention = "needs_approval";
    } else {
      this.status = this.activeTurnId ? "working" : "idle";
      this.attention = this.activeTurnId ? "working" : "none";
    }
  }

  private resumeWorkingState(): void {
    this.refreshWorkingState();
    this.publishUpdate();
  }

  private handleUsage(params: Record<string, unknown>): void {
    const cumulative = recordOf(params["cumulative"]);
    const counter = numberValue(cumulative?.["totalTokens"]);
    if (!this.sessionId || counter === undefined) return;
    this.emit({
      type: "usage.spent",
      threadId: this.input.threadId,
      usage: {
        counterKind: "cumulative",
        counter,
        scopeId: this.sessionId,
        epoch: this.usageEpoch,
        ...(this.usageScopeFresh ? { fresh: true } : {}),
        sampleId: `${this.sessionId}:${this.usageEpoch}:${counter}`,
        ...(stringValue(params["turnId"]) ? { turnId: stringValue(params["turnId"]) } : {}),
        ...(stringValue(params["modelId"]) ? { model: stringValue(params["modelId"]) } : {}),
      },
    });
    this.usageScopeFresh = false;
  }

  private publishUpdate(): void {
    this.listener.onUpdate({
      status: this.status,
      attention: this.attention,
      config: this.currentConfig,
      ...(this.sessionId
        ? {
            sessionRef: {
              ...createKnownSessionRef(this.sessionId),
              ...(this.sessionDiscoveredAt ? { discoveredAt: this.sessionDiscoveredAt } : {}),
              ...(this.lastViewCursor ? { providerCursor: this.lastViewCursor } : {}),
            },
          }
        : {}),
    });
  }

  private emitMany(events: readonly RuntimeEvent[]): void {
    for (const event of events) this.emit(event);
  }

  private emit(event: RuntimeEvent): void {
    if (!this.listener.onRuntimeEvent) {
      this.bufferedEvents.push(event);
      return;
    }
    this.listener.onRuntimeEvent(event);
  }

  private handleTransportError(error: Error): void {
    if (this.disposed || this.transportErrorReported) return;
    this.transportErrorReported = true;
    this.clearPendingCompact();
    this.listener.onError(error.message);
  }

  private handleTransportClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.disposed || this.transportCloseReported) return;
    this.transportCloseReported = true;
    // Nothing can settle a pending compaction once the host is gone; drop the
    // timer now instead of retaining the session graph until it fires.
    this.clearPendingCompact();
    if (this.activeTurnId) this.completeTurn(this.activeTurnId, "failed");
    const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    this.emit({ type: "session.exited", threadId: this.input.threadId, reason: "exited" });
    this.listener.onError(`Muse MSP server exited unexpectedly (${detail}).`);
    this.listener.onClose();
  }
}
