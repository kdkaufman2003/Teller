import { describe, expect, it } from "vitest";
import { buildJobProfitability } from "./job-reports";

const ACCOUNTS = [
  { id: "r1", code: "4100", name: "Installation Labor", type: "revenue" },
  { id: "c1", code: "5200", name: "Subcontractor Cost", type: "cogs" },
  { id: "e1", code: "6100", name: "Vehicle & Fuel", type: "expense" },
];

describe("buildJobProfitability", () => {
  it("totals revenue, direct cost, and indirect cost for a job", () => {
    const report = buildJobProfitability(
      "job-1",
      [
        { account_id: "r1", debit: 0, credit: 5000, job_id: "job-1" },
        { account_id: "c1", debit: 1800, credit: 0, job_id: "job-1", cost_classification: "direct" },
        {
          account_id: "e1",
          debit: 200,
          credit: 0,
          job_id: "job-1",
          cost_classification: "indirect",
        },
        { account_id: "r1", debit: 0, credit: 1000, job_id: "job-2" },
      ],
      ACCOUNTS,
    );

    expect(report.revenue).toBe(5000);
    expect(report.cogs).toBe(1800);
    expect(report.grossProfit).toBe(3200);
    expect(report.expenses).toBe(200);
    expect(report.netJobProfit).toBe(3000);
  });
});
