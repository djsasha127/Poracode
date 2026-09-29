import { useLingui } from "@lingui/react/macro";
import type { UsageSnapshot } from "@poracode/agents-usage/types";
import { formatMoney, formatTokens } from "./usageFormat";
import { UsageMonthlyHistory } from "./UsageMonthlyHistory";

/** Shared billed or estimated cost line for usage cards and rail tooltips. */
export function UsageCostLine(props: {
  snapshot: UsageSnapshot;
  className?: string;
  sourceLabel?: string;
}) {
  const { t } = useLingui();
  const { snapshot, className } = props;
  if (!snapshot.cost && !snapshot.tokens && !snapshot.history) return null;

  const tokens = snapshot.tokens?.total
    ? ` · ${t`${formatTokens(snapshot.tokens.total)} tokens`}`
    : "";
  const unpriced = Math.max(
    0,
    (snapshot.tokens?.total ?? 0) - (snapshot.tokens?.priced ?? snapshot.tokens?.total ?? 0),
  );
  const proxyPriced = snapshot.tokens?.proxyPriced ?? 0;
  const money = snapshot.cost
    ? formatMoney(snapshot.cost.amount, snapshot.cost.currency)
    : undefined;
  const line = snapshot.cost
    ? snapshot.cost.estimated
      ? t`~${money}${tokens} · ${snapshot.cost.period} · est.`
      : `${money}${tokens} · ${snapshot.cost.period}`
    : tokens.replace(/^ · /, "");
  const notes = [
    proxyPriced > 0 ? t`${formatTokens(proxyPriced)} tokens use a public proxy rate` : undefined,
    unpriced > 0 ? t`${formatTokens(unpriced)} tokens are unpriced` : undefined,
  ].filter((note): note is string => Boolean(note));

  if (className) {
    return (
      <div className={className} title={notes.length > 0 ? notes.join(" · ") : undefined}>
        {line}
      </div>
    );
  }

  const exactTokens = snapshot.tokens?.total
    ? new Intl.NumberFormat().format(Math.round(snapshot.tokens.total))
    : undefined;
  const categories = snapshot.tokens
    ? [
        { label: t`Input`, value: snapshot.tokens.input },
        { label: t`Output`, value: snapshot.tokens.output },
        { label: t`Cache read`, value: snapshot.tokens.cacheRead },
        { label: t`Cache write`, value: snapshot.tokens.cacheWrite },
      ].filter((entry): entry is { label: string; value: number } => Boolean(entry.value))
    : [];

  return (
    <div className="space-y-1.5 border-t border-[color:var(--separator)] pt-2">
      {snapshot.tokens?.total ? (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted">
            {t`30-day transcript tokens`}
            {props.sourceLabel ? ` · ${props.sourceLabel}` : ""}
          </span>
          <span className="tabular-nums text-foreground" title={exactTokens}>
            {formatTokens(snapshot.tokens.total)}
          </span>
        </div>
      ) : null}
      {money ? (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted">{t`API-rate equivalent`}</span>
          <span className="tabular-nums font-medium text-foreground">~{money}</span>
        </div>
      ) : null}
      {categories.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted/80">
          {categories.map((entry) => (
            <span key={entry.label} className="truncate tabular-nums">
              {entry.label} {formatTokens(entry.value)}
            </span>
          ))}
        </div>
      ) : null}
      <p className="text-[10px] leading-tight text-muted/60">
        {notes.length > 0
          ? notes.join(" · ")
          : t`Estimated at public API rates; your subscription is not charged this amount.`}
      </p>
      {snapshot.history ? <UsageMonthlyHistory history={snapshot.history} /> : null}
    </div>
  );
}
