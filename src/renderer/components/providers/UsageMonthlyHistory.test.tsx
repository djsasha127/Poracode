import { screen } from "@testing-library/react";
import type { UsageHistory } from "@poracode/agents-usage/types";
import { describe, expect, it } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { UsageMonthlyHistory } from "./UsageMonthlyHistory";

const history: UsageHistory = {
  months: [
    {
      month: "2026-09",
      tokens: {
        total: 1_000,
        input: 100,
        output: 100,
        cacheRead: 800,
        cacheWrite: 0,
        priced: 1_000,
        proxyPriced: 0,
      },
      estimatedCostUsd: 12.5,
      models: [],
    },
    {
      month: "2026-08",
      tokens: {
        total: 500,
        input: 100,
        output: 50,
        cacheRead: 350,
        cacheWrite: 0,
        priced: 500,
        proxyPriced: 0,
      },
      estimatedCostUsd: 7.75,
      models: [],
    },
  ],
};

describe("UsageMonthlyHistory", () => {
  it("shows the lifetime amount in the existing history summary row", () => {
    render(<UsageMonthlyHistory history={history} />);

    const summary = screen.getByText("History").closest("summary");
    expect(summary).toHaveTextContent("All time · ~$20.25");
    expect(summary?.querySelectorAll(":scope > span")).toHaveLength(2);
  });
});
