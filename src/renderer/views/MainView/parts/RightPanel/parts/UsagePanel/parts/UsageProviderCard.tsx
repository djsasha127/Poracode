import { type FormEvent, useState } from "react";
import { useSortable } from "@dnd-kit/react/sortable";
import { ChevronDown, ChevronRight, GripVertical, LogOut, RefreshCw } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { usageWindowDisplayLabel } from "@poracode/agents-usage/formatters";
import type { UsageSnapshot } from "@poracode/agents-usage/types";
import type { ProfileTokenBreakdown, ProfileTokenProvider } from "@/shared/contracts";
import { ProviderIcon } from "@/renderer/components/providers/ProviderIcon";
import { UsageWindowBars } from "@/renderer/components/providers/UsageWindowBars";
import { UsageCostLine } from "@/renderer/components/providers/UsageCostLine";
import { UsageHistoryPanelExtension } from "@/renderer/components/providers/usageHistoryExtensions";
import {
  formatCreditBalance,
  formatEstimatedMoney,
  formatTokens,
  formatWindowValue,
  hasDisplayableCredits,
  sharedWindowResetLabel,
  usageStatusText,
} from "@/renderer/components/providers/usageFormat";
import { usageToneColor } from "@/renderer/components/providers/usageTone";
import {
  supportsApiKeyLogin,
  usesSharedWindowReset,
} from "@/renderer/components/providers/usageProviders";
import { useProviderUsageRefresh } from "@/renderer/components/providers/useProviderUsageRefresh";
import { useUsageProviderLogin } from "@/renderer/components/providers/useUsageProviderLogin";
import { useProviderUsage } from "@/renderer/state/providerUsageStore";
import { useRemoteServersStore } from "@/renderer/state/remoteServersStore";
import { hasScannedTokenHistory } from "../recordedUsageSource";

/** Compact one-line window chips shown when the card is collapsed. */
function WindowChips(props: {
  windows: UsageSnapshot["windows"];
  credits?: UsageSnapshot["credits"];
}) {
  const { t } = useLingui();
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {props.windows.map((w) => (
        <span key={w.id} className="flex items-center gap-1 whitespace-nowrap text-xs">
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: usageToneColor(w.usedPercent) }}
          />
          <span className="text-muted">{usageWindowDisplayLabel(w)}</span>
          <span className="tabular-nums text-foreground">{formatWindowValue(w)}</span>
        </span>
      ))}
      {props.credits ? (
        <span className="flex items-center gap-1 whitespace-nowrap text-xs">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-muted/60" />
          <span className="text-muted">{props.credits.label ?? t`Credits`}</span>
          <span className="tabular-nums text-foreground">
            {props.credits.unlimited ? t`Unlimited` : formatCreditBalance(props.credits)}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function PlanLabel(props: { plan: string; account?: string }) {
  if (!props.account) {
    return <span className="truncate text-xs text-muted">{props.plan}</span>;
  }

  return (
    <span className="group/account relative min-w-0" title={props.account}>
      <span className="block truncate text-xs text-muted">{props.plan}</span>
      <span className="pointer-events-none absolute left-0 top-full z-[1000] mt-1 whitespace-nowrap rounded-md bg-surface px-2 py-1 text-xs text-foreground opacity-0 shadow-lg ring-1 ring-[color:var(--separator)] transition-opacity group-hover/account:opacity-100">
        {props.account}
      </span>
    </span>
  );
}

function RecordedTokenCost(props: {
  usage: ProfileTokenProvider;
  pricingReviewedAt?: string;
  sourceLabel?: string;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const { usage } = props;
  const exactTokens = new Intl.NumberFormat().format(Math.round(usage.tokens));
  const money = formatEstimatedMoney(usage.estimatedCostUsd);
  const unpricedTokens = Math.max(0, usage.tokens - (usage.pricedTokens ?? 0));

  if (props.compact) {
    return (
      <span className="flex items-center gap-1 whitespace-nowrap text-xs">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />
        <span className="text-muted">
          {t`Tokens`}
          {props.sourceLabel ? ` · ${props.sourceLabel}` : ""}
        </span>
        <span className="tabular-nums text-foreground" title={exactTokens}>
          {formatTokens(usage.tokens)}
          {money ? ` · ~${money}` : ""}
        </span>
      </span>
    );
  }

  const categories: Array<{ key: keyof ProfileTokenBreakdown; label: string; tokens: number }> =
    usage.breakdown
      ? [
          { key: "input" as const, label: t`Input`, tokens: usage.breakdown.input },
          { key: "output" as const, label: t`Output`, tokens: usage.breakdown.output },
          { key: "cacheRead" as const, label: t`Cache read`, tokens: usage.breakdown.cacheRead },
          { key: "cacheWrite" as const, label: t`Cache write`, tokens: usage.breakdown.cacheWrite },
        ].filter((entry) => entry.tokens > 0)
      : [];

  return (
    <div className="space-y-1.5 border-t border-[color:var(--separator)] pt-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted">
          {t`Recorded tokens`}
          {props.sourceLabel ? ` · ${props.sourceLabel}` : ""}
        </span>
        <span className="tabular-nums text-foreground" title={exactTokens}>
          {formatTokens(usage.tokens)}
        </span>
      </div>
      {money ? (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted">{t`All-time API equivalent`}</span>
          <span className="tabular-nums font-medium text-foreground">~{money}</span>
        </div>
      ) : null}
      {categories.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted/80">
          {categories.map((entry) => {
            const categoryCost = usage.costBreakdownUsd?.[entry.key];
            return (
              <span key={entry.key} className="truncate tabular-nums">
                {entry.label} {formatTokens(entry.tokens)}
                {categoryCost ? ` → ${formatEstimatedMoney(categoryCost)}` : ""}
              </span>
            );
          })}
        </div>
      ) : null}
      <p className="text-[10px] leading-tight text-muted/60">
        {unpricedTokens > 0
          ? t`${formatTokens(unpricedTokens)} tokens have no known public model rate.`
          : t`Estimated at public API rates; your subscription is not charged this amount.`}
        {props.pricingReviewedAt ? ` · ${t`Rates ${props.pricingReviewedAt}`}` : ""}
      </p>
    </div>
  );
}

export function UsageProviderCard(props: {
  id: string;
  label: string;
  index: number;
  collapsed: boolean;
  onToggleCollapse: (id: string) => void;
  snapshot: UsageSnapshot | undefined;
  recordedUsage?: ProfileTokenProvider;
  recordedUsageSourceLabel?: string;
  pricingReviewedAt?: string;
  onRefreshRecordedUsage?: () => Promise<unknown>;
  remoteServerId?: string;
  sourceLabel?: string;
  historyRemoteServerId?: string;
  historyRemoteSourceLabel?: string;
}) {
  const { id, label, index, collapsed, onToggleCollapse, remoteServerId, sourceLabel } = props;
  const { t } = useLingui();
  const localSnapshot = useProviderUsage(id);
  const snapshot = remoteServerId ? props.snapshot : localSnapshot;
  const {
    canBrowserSignIn,
    canApiKeySignIn,
    canCliSignIn,
    canSignOut,
    signingIn: localSigningIn,
    signingOut,
    apiKey,
    setApiKey,
    handleSignIn,
    handleCliSignIn,
    handleSubmitApiKey,
    handleSignOut,
  } = useUsageProviderLogin(id);
  const { refreshing: localRefreshing, refresh: refreshLocal } = useProviderUsageRefresh(id);
  const [remoteRefreshing, setRemoteRefreshing] = useState(false);
  const [remoteSigningIn, setRemoteSigningIn] = useState(false);
  const [remoteSignInError, setRemoteSignInError] = useState<string>();
  const signingIn = remoteServerId ? remoteSigningIn : localSigningIn;
  const refreshing = remoteServerId ? remoteRefreshing : localRefreshing;
  const refresh = async () => {
    if (!remoteServerId) {
      await Promise.all([refreshLocal(), props.onRefreshRecordedUsage?.()]);
      return;
    }
    if (remoteRefreshing) return;
    setRemoteRefreshing(true);
    try {
      await Promise.all([
        useRemoteServersStore.getState().refreshProviderUsage(remoteServerId, [id]),
        props.onRefreshRecordedUsage?.(),
      ]);
    } finally {
      setRemoteRefreshing(false);
    }
  };
  const onSubmitApiKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!remoteServerId) {
      await handleSubmitApiKey();
      return;
    }
    if (remoteSigningIn || apiKey.trim().length === 0) return;
    setRemoteSigningIn(true);
    setRemoteSignInError(undefined);
    try {
      await useRemoteServersStore
        .getState()
        .setProviderUsageApiKey(remoteServerId, id, apiKey.trim());
      setApiKey("");
    } catch (error) {
      setRemoteSignInError(error instanceof Error ? error.message : t`Provider sign-in failed`);
    } finally {
      setRemoteSigningIn(false);
    }
  };
  const { ref, handleRef, isDragging } = useSortable({
    id: `usage-order:${id}`,
    index,
    type: "usage-provider-order",
    accept: ["usage-provider-order"],
    group: "usage-provider-order",
    data: { id },
  });

  const credits = hasDisplayableCredits(snapshot?.credits, snapshot?.windows ?? [])
    ? snapshot?.credits
    : undefined;
  const hasQuotaUsage =
    snapshot?.status === "ok" && (snapshot.windows.length > 0 || Boolean(credits));
  const hasTranscriptUsage = Boolean(snapshot?.cost || snapshot?.tokens || snapshot?.history);
  const hasWindows = snapshot?.status === "ok" && snapshot.windows.length > 0;
  const scannedTokenHistory = hasScannedTokenHistory(snapshot);
  const recordedUsage = scannedTokenHistory ? undefined : props.recordedUsage;
  // Mount-time clock for the reset label (same pattern as UsageWindowBars):
  // impure reads can't run during render, and the card re-renders on snapshot
  // updates anyway.
  const [now] = useState(() => Date.now());
  const sharedReset = usesSharedWindowReset(id) ? sharedWindowResetLabel(snapshot, now) : undefined;
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div
      ref={ref}
      className={`rounded-2xl border border-[color:var(--separator)] bg-surface ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <button
          ref={handleRef}
          type="button"
          aria-label={t`Reorder ${label}`}
          className="flex size-4 shrink-0 cursor-grab items-center justify-center text-muted/40 transition-colors hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </button>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t`Expand ${label}` : t`Collapse ${label}`}
          onClick={() => onToggleCollapse(id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:focus-ring"
        >
          <ProviderIcon kind={id} fallbackLabel={label} className="size-4 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">{label}</span>
              {snapshot?.plan ? (
                <PlanLabel
                  plan={snapshot.plan}
                  {...(snapshot.authenticatedAs ? { account: snapshot.authenticatedAs } : {})}
                />
              ) : null}
              {sharedReset ? (
                <>
                  {snapshot?.plan ? (
                    <span className="shrink-0 text-xs text-muted/60" aria-hidden>
                      ·
                    </span>
                  ) : null}
                  <span className="shrink-0 text-xs tabular-nums text-muted">{sharedReset}</span>
                </>
              ) : null}
            </span>
            {sourceLabel ? (
              <span className="shrink-0 text-[10px] text-muted/60">{sourceLabel}</span>
            ) : null}
            {collapsed && (!hasWindows || !snapshot) ? (
              <span className="text-xs text-muted">{usageStatusText(snapshot, label, id)}</span>
            ) : null}
          </span>
        </button>
        <button
          type="button"
          aria-label={t`Refresh ${label}`}
          title={t`Refresh ${label}`}
          onClick={() => void refresh()}
          disabled={refreshing}
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted/60 transition-colors hover:bg-muted/10 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
        </button>
        {!remoteServerId && canSignOut ? (
          <button
            type="button"
            aria-label={t`Sign out ${label}`}
            title={t`Sign out ${label}`}
            onClick={() => void handleSignOut()}
            disabled={signingOut}
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted/60 transition-colors hover:bg-muted/10 hover:text-foreground disabled:opacity-50"
          >
            <LogOut className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t`Expand ${label}` : t`Collapse ${label}`}
          onClick={() => onToggleCollapse(id)}
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted/60 transition-colors hover:bg-muted/10 hover:text-foreground"
        >
          <Chevron className="size-4" />
        </button>
      </div>
      {collapsed && hasWindows && snapshot ? (
        <div className="px-2.5 pb-2">
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <WindowChips windows={snapshot.windows} {...(credits ? { credits } : {})} />
            {recordedUsage ? (
              <RecordedTokenCost
                usage={recordedUsage}
                {...(props.recordedUsageSourceLabel
                  ? { sourceLabel: props.recordedUsageSourceLabel }
                  : {})}
                compact
              />
            ) : null}
          </div>
        </div>
      ) : collapsed && recordedUsage ? (
        <div className="px-2.5 pb-2">
          <RecordedTokenCost
            usage={recordedUsage}
            {...(props.recordedUsageSourceLabel
              ? { sourceLabel: props.recordedUsageSourceLabel }
              : {})}
            compact
          />
        </div>
      ) : null}

      {!collapsed ? (
        <div className="space-y-2.5 border-t border-[color:var(--separator)] px-3 pb-4 pt-3">
          {hasQuotaUsage && snapshot ? (
            <>
              {snapshot.windows.length ? (
                <UsageWindowBars
                  windows={snapshot.windows}
                  showReset={!usesSharedWindowReset(id)}
                />
              ) : null}
              {credits ? (
                <UsageCreditsRow
                  credits={credits}
                  showSeparator={Boolean(snapshot.windows.length)}
                />
              ) : null}
            </>
          ) : !hasTranscriptUsage || snapshot?.status !== "ok" ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">{usageStatusText(snapshot, label, id)}</p>
              {remoteServerId ? (
                <p className="text-[11px] text-muted/70">
                  <Trans>
                    Account access is read from {sourceLabel ?? remoteServerId}; no extra usage CLI
                    is required.
                  </Trans>
                </p>
              ) : null}
              {!remoteServerId && canBrowserSignIn ? (
                <button
                  type="button"
                  onClick={() => void handleSignIn()}
                  disabled={signingIn}
                  className="rounded-lg border border-[color:var(--separator)] bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/10 disabled:opacity-50"
                >
                  {signingIn ? <Trans>Signing in…</Trans> : <Trans>Browser sign-in</Trans>}
                </button>
              ) : null}
              {!remoteServerId && canCliSignIn ? (
                <button
                  type="button"
                  onClick={handleCliSignIn}
                  disabled={signingIn}
                  className="rounded-lg border border-[color:var(--separator)] bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/10 disabled:opacity-50"
                >
                  {signingIn ? <Trans>Signing in…</Trans> : <Trans>Sign in</Trans>}
                </button>
              ) : null}
              {(
                !remoteServerId
                  ? canApiKeySignIn
                  : snapshot?.status === "auth-missing" && supportsApiKeyLogin(id)
              ) ? (
                <div className="space-y-1">
                  <form
                    onSubmit={(event) => void onSubmitApiKey(event)}
                    className="flex items-center gap-1.5"
                  >
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={t`Paste ${label} API key`}
                      aria-label={t`${label} API key`}
                      autoComplete="off"
                      spellCheck={false}
                      className="min-w-0 flex-1 rounded-lg border border-[color:var(--separator)] bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:focus-ring"
                    />
                    <button
                      type="submit"
                      disabled={signingIn || apiKey.trim().length === 0}
                      className="shrink-0 rounded-lg border border-[color:var(--separator)] bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/10 disabled:opacity-50"
                    >
                      {signingIn ? <Trans>Signing in…</Trans> : <Trans>Sign in</Trans>}
                    </button>
                  </form>
                  {remoteSignInError ? (
                    <p className="text-[10px] text-danger">{remoteSignInError}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {hasTranscriptUsage && snapshot ? (
            <UsageCostLine snapshot={snapshot} {...(sourceLabel ? { sourceLabel } : {})} />
          ) : null}
          {recordedUsage ? (
            <RecordedTokenCost
              usage={recordedUsage}
              {...(props.pricingReviewedAt ? { pricingReviewedAt: props.pricingReviewedAt } : {})}
              {...(props.recordedUsageSourceLabel
                ? { sourceLabel: props.recordedUsageSourceLabel }
                : {})}
            />
          ) : null}
          <UsageHistoryPanelExtension
            providerId={id}
            {...(props.historyRemoteServerId
              ? { remoteServerId: props.historyRemoteServerId }
              : {})}
            {...(props.historyRemoteSourceLabel
              ? { remoteSourceLabel: props.historyRemoteSourceLabel }
              : {})}
          />
        </div>
      ) : null}
    </div>
  );
}

function UsageCreditsRow(props: {
  credits: NonNullable<UsageSnapshot["credits"]>;
  showSeparator: boolean;
}) {
  const { t } = useLingui();
  const { credits } = props;

  return (
    <div
      className={`flex items-center justify-between gap-3 ${
        props.showSeparator ? "border-t border-[color:var(--separator)] pt-2" : ""
      }`}
    >
      <span className="text-xs text-muted">{credits.label ?? t`Credits`}</span>
      <span className="tabular-nums text-xs text-foreground">
        {credits.unlimited ? t`Unlimited` : formatCreditBalance(credits)}
      </span>
    </div>
  );
}
