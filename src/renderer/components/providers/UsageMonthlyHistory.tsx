import { Trans, useLingui } from "@lingui/react/macro";
import type { UsageHistory } from "@poracode/agents-usage/types";
import { ChevronRightIcon } from "lucide-react";
import { formatEstimatedMoney, formatTokens, summarizeUsageHistory } from "./usageFormat";

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return month;
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

/** Expandable calendar-month model/effort breakdown reconstructed from local transcripts. */
export function UsageMonthlyHistory({ history }: { history: UsageHistory }) {
  const { t } = useLingui();
  if (history.months.length === 0) return null;
  const lifetime = summarizeUsageHistory(history);
  const lifetimeTitle = [
    t`${formatTokens(lifetime.tokens)} tokens`,
    lifetime.proxyPricedTokens > 0
      ? t`${formatTokens(lifetime.proxyPricedTokens)} tokens use a public proxy rate`
      : undefined,
    lifetime.pricedTokens < lifetime.tokens
      ? t`${formatTokens(lifetime.tokens - lifetime.pricedTokens)} tokens are unpriced`
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <details className="group/history border-t border-[color:var(--separator)] pt-1.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium text-muted hover:text-foreground">
        <span className="flex min-w-0 items-center gap-1">
          <ChevronRightIcon className="size-3 shrink-0 transition-transform group-open/history:rotate-90" />
          <Trans>History</Trans>
        </span>
        {lifetime.pricedTokens > 0 ? (
          <span className="shrink-0 tabular-nums text-foreground" title={lifetimeTitle}>
            <Trans>All time</Trans> · ~{formatEstimatedMoney(lifetime.estimatedCostUsd)}
          </span>
        ) : null}
      </summary>
      <div className="mt-1.5 space-y-1.5">
        {history.months.map((month) => {
          const hasPricedTokens = (month.tokens.priced ?? 0) > 0;
          return (
            <details
              key={month.month}
              className="group/month rounded-md border border-[color:var(--separator)] bg-muted/5 px-2 py-1.5"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px]">
                <span className="flex min-w-0 items-center gap-1 font-medium text-foreground">
                  <ChevronRightIcon className="size-3 shrink-0 transition-transform group-open/month:rotate-90" />
                  <span className="truncate capitalize">{formatMonth(month.month)}</span>
                </span>
                <span className="shrink-0 tabular-nums text-muted">
                  {formatTokens(month.tokens.total)}
                  {hasPricedTokens ? ` · ~${formatEstimatedMoney(month.estimatedCostUsd)}` : ""}
                </span>
              </summary>
              <div className="mt-1.5 space-y-1 border-t border-[color:var(--separator)] pt-1.5">
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] tabular-nums text-muted/70">
                  {(month.tokens.input ?? 0) > 0 ? (
                    <span>
                      {t`Input`} {formatTokens(month.tokens.input)}
                    </span>
                  ) : null}
                  {(month.tokens.output ?? 0) > 0 ? (
                    <span>
                      {t`Output`} {formatTokens(month.tokens.output)}
                    </span>
                  ) : null}
                  {(month.tokens.cacheRead ?? 0) > 0 ? (
                    <span>
                      {t`Cache read`} {formatTokens(month.tokens.cacheRead)}
                    </span>
                  ) : null}
                  {(month.tokens.cacheWrite ?? 0) > 0 ? (
                    <span>
                      {t`Cache write`} {formatTokens(month.tokens.cacheWrite)}
                    </span>
                  ) : null}
                  {(month.reasoningTokens ?? 0) > 0 ? (
                    <span>
                      {t`Thinking`} {formatTokens(month.reasoningTokens)}
                    </span>
                  ) : null}
                </div>
                {month.models.map((model) => {
                  const key = `${model.model}:${model.effort ?? ""}`;
                  const modelHasPrice = (model.tokens.priced ?? 0) > 0;
                  return (
                    <div key={key} className="flex items-start justify-between gap-2 text-[10px]">
                      <div className="min-w-0">
                        <div className="truncate text-foreground" title={model.model}>
                          {model.model}
                        </div>
                        <div className="text-muted/70">
                          {t`Reasoning`}: {model.effort ?? t`Unknown`}
                          {model.reasoningTokens
                            ? ` · ${t`Thinking`} ${formatTokens(model.reasoningTokens)}`
                            : ""}
                        </div>
                        {(model.tokens.proxyPriced ?? 0) > 0 ? (
                          <div className="text-muted/60">
                            {t`${formatTokens(model.tokens.proxyPriced)} tokens use a public proxy rate`}
                          </div>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-right tabular-nums text-muted">
                        <div>{t`${formatTokens(model.tokens.total)} tokens`}</div>
                        {modelHasPrice ? (
                          <div>~{formatEstimatedMoney(model.estimatedCostUsd)}</div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>
    </details>
  );
}
