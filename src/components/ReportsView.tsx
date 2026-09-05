"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { money } from "@/lib/format";
import type {
  AgingReport,
  BalanceSheet,
  CashFlowStatement,
  ReportTab,
} from "@/lib/accounting/financial-reports";
import type {
  AccountingBasis,
  ProfitAndLoss,
  ReportPeriod,
  SalesSummary,
} from "@/lib/accounting/reports";

const PERIODS: { id: ReportPeriod; label: string }[] = [
  { id: "month", label: "This month" },
  { id: "quarter", label: "This quarter" },
  { id: "ytd", label: "Year to date" },
  { id: "all", label: "All time" },
];

const TABS: { id: ReportTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "balance_sheet", label: "Balance sheet" },
  { id: "cash_flow", label: "Cash flow" },
  { id: "ar_aging", label: "AR aging" },
  { id: "ap_aging", label: "AP aging" },
];

export function ReportsView({
  period,
  periodLabel,
  asOf,
  tab,
  basis,
  sales,
  profitAndLoss,
  balanceSheet,
  cashFlow,
  arAging,
  apAging,
}: {
  period: ReportPeriod;
  periodLabel: string;
  asOf: string;
  tab: ReportTab;
  basis: AccountingBasis;
  sales: SalesSummary;
  profitAndLoss: ProfitAndLoss;
  balanceSheet: BalanceSheet;
  cashFlow: CashFlowStatement;
  arAging: AgingReport;
  apAging: AgingReport;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function pushParams(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      params.set(key, value);
    }
    router.push(`?${params.toString()}`);
  }

  const maxMonthTotal = Math.max(
    1,
    ...sales.byMonth.map((row) => Math.max(row.invoiced, row.collected)),
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Period</p>
          <p className="font-ledger text-xl text-navy">{periodLabel}</p>
          {tab !== "overview" ? (
            <p className="mt-1 text-xs text-muted">As of {asOf}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg border border-rule bg-paper-strong p-1">
          {PERIODS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => pushParams({ period: item.id })}
              className={`rounded-md px-3 py-1.5 text-sm ${
                period === item.id ? "bg-navy text-white" : "text-muted hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 rounded-lg border border-rule bg-paper-strong p-1">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => pushParams({ tab: item.id })}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === item.id ? "bg-navy text-white" : "text-muted hover:text-ink"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <OverviewTab
          basis={basis}
          sales={sales}
          profitAndLoss={profitAndLoss}
          periodLabel={periodLabel}
          maxMonthTotal={maxMonthTotal}
        />
      ) : null}

      {tab === "balance_sheet" ? <BalanceSheetTab report={balanceSheet} /> : null}
      {tab === "cash_flow" ? (
        <CashFlowTab report={cashFlow} periodLabel={periodLabel} />
      ) : null}
      {tab === "ar_aging" ? (
        <AgingTab title="Accounts receivable aging" report={arAging} entityLabel="Customer" />
      ) : null}
      {tab === "ap_aging" ? (
        <AgingTab title="Accounts payable aging" report={apAging} entityLabel="Vendor" />
      ) : null}
    </div>
  );
}

function OverviewTab({
  basis,
  sales,
  profitAndLoss,
  periodLabel,
  maxMonthTotal,
}: {
  basis: AccountingBasis;
  sales: SalesSummary;
  profitAndLoss: ProfitAndLoss;
  periodLabel: string;
  maxMonthTotal: number;
}) {
  return (
    <>
      {sales.awaitingPayment > 0 && basis === "accrual" ? (
        <p className="rounded-lg border border-rule bg-paper-strong px-4 py-3 text-sm text-muted">
          <strong className="text-ink">Collected {money(sales.collected)}</strong> is money
          you&apos;ve received.{" "}
          <strong className="text-ink">{money(sales.awaitingPayment)} awaiting payment</strong>{" "}
          is an open invoice not paid yet. Total posted invoices (
          {money(sales.postedTotal)}) = collected + awaiting — not double your sales.
        </p>
      ) : null}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Collected",
            value: money(sales.collected),
            hint: `${sales.paidCount} paid · money received`,
          },
          {
            label: "Awaiting payment",
            value: money(sales.awaitingPayment),
            hint: `${sales.openCount} open invoice${sales.openCount === 1 ? "" : "s"}`,
          },
          ...(basis === "accrual"
            ? [
                {
                  label: "Total posted",
                  value: money(sales.postedTotal),
                  hint: "Collected + awaiting",
                },
              ]
            : []),
          {
            label: basis === "cash" ? "Net income (cash)" : "Net income",
            value: money(profitAndLoss.netIncome),
            hint:
              basis === "cash"
                ? "Revenue when paid · from ledger"
                : "Revenue when invoiced · from ledger",
          },
        ].map((metric) => (
          <article key={metric.label} className="card p-4">
            <p className="text-xs uppercase tracking-[0.14em] text-muted">{metric.label}</p>
            <p className="font-ledger mt-2 text-2xl font-tabular text-navy">{metric.value}</p>
            <p className="mt-1 text-xs text-muted">{metric.hint}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <article className="report-sheet card p-5">
          <h2 className="font-ledger text-2xl text-navy">Sales trend</h2>
          <p className="mt-1 text-sm text-muted">
            {basis === "cash"
              ? "Collected by month (cash basis)"
              : "Posted vs collected by month (accrual)"}
          </p>
          {sales.byMonth.length === 0 ? (
            <p className="mt-6 text-sm text-muted">No invoice activity in this period.</p>
          ) : (
            <ul className="mt-5 space-y-3">
              {sales.byMonth.map((row) => (
                <li key={row.month}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span>{row.label}</span>
                    <span className="font-tabular text-muted">
                      {basis === "cash"
                        ? money(row.collected)
                        : `${money(row.invoiced)} / ${money(row.collected)}`}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <Bar amount={row.invoiced} max={maxMonthTotal} tone="navy" />
                    <Bar amount={row.collected} max={maxMonthTotal} tone="brass" />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex gap-4 text-xs text-muted">
            {basis === "accrual" ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-4 rounded bg-navy" /> Posted
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-4 rounded bg-brass" /> Collected
            </span>
          </div>
        </article>

        <article className="report-sheet card p-5">
          <h2 className="font-ledger text-2xl text-navy">Top customers</h2>
          <p className="mt-1 text-sm text-muted">
            {basis === "cash" ? "By collected amount" : "By posted billed amount"} in this
            period
          </p>
          {sales.topCustomers.length === 0 ? (
            <p className="mt-6 text-sm text-muted">No customer sales yet.</p>
          ) : (
            <table className="report-table mt-4">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Invoices</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {sales.topCustomers.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td className="font-tabular text-muted">{row.invoiceCount}</td>
                    <td className="text-right font-tabular">{money(row.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </section>

      <article className="report-sheet card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule pb-4">
          <div>
            <h2 className="font-ledger text-2xl text-navy">Profit &amp; Loss</h2>
            <p className="mt-1 text-sm text-muted">
              Posted activity from the general ledger · {periodLabel} ·{" "}
              {basis === "cash" ? "cash basis" : "accrual basis"}
            </p>
          </div>
          <Link href="/app/ledger" className="text-sm text-sky">
            View ledger
          </Link>
        </div>

        <ProfitLossTable report={profitAndLoss} />
      </article>
    </>
  );
}

function BalanceSheetTab({ report }: { report: BalanceSheet }) {
  const empty =
    report.totalAssets === 0 && report.totalLiabilities === 0 && report.totalEquity === 0;

  return (
    <article className="report-sheet card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule pb-4">
        <div>
          <h2 className="font-ledger text-2xl text-navy">Balance sheet</h2>
          <p className="mt-1 text-sm text-muted">As of {report.asOf} · from general ledger</p>
        </div>
        {!report.balanced ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
            Totals do not balance — review posted entries.
          </p>
        ) : null}
      </div>

      {empty ? (
        <p className="mt-6 text-sm text-muted">No balance sheet activity posted yet.</p>
      ) : (
        <table className="report-table mt-5">
          <tbody>
            <SectionHeader title="Assets" />
            {report.assets.length === 0 ? (
              <EmptyRow />
            ) : (
              report.assets.map((row) => (
                <FinancialRow key={row.code} code={row.code} name={row.name} amount={row.amount} />
              ))
            )}
            <TotalRow label="Total assets" amount={report.totalAssets} emphasis />

            <SectionHeader title="Liabilities" />
            {report.liabilities.length === 0 ? (
              <EmptyRow />
            ) : (
              report.liabilities.map((row) => (
                <FinancialRow key={row.code} code={row.code} name={row.name} amount={row.amount} />
              ))
            )}
            <TotalRow label="Total liabilities" amount={report.totalLiabilities} />

            <SectionHeader title="Equity" />
            {report.equity.length === 0 ? (
              <EmptyRow />
            ) : (
              report.equity.map((row) => (
                <FinancialRow key={row.code} code={row.code} name={row.name} amount={row.amount} />
              ))
            )}
            <TotalRow label="Total equity" amount={report.totalEquity} emphasis />
          </tbody>
        </table>
      )}
    </article>
  );
}

function CashFlowTab({
  report,
  periodLabel,
}: {
  report: CashFlowStatement;
  periodLabel: string;
}) {
  const empty =
    report.beginningCash === 0 &&
    report.endingCash === 0 &&
    report.netOperating === 0 &&
    report.netChangeInCash === 0;

  return (
    <article className="report-sheet card p-5">
      <div className="border-b border-rule pb-4">
        <h2 className="font-ledger text-2xl text-navy">Cash flow statement</h2>
        <p className="mt-1 text-sm text-muted">
          Indirect method · {periodLabel} · operating activity from ledger
        </p>
      </div>

      {empty ? (
        <p className="mt-6 text-sm text-muted">No cash activity posted yet.</p>
      ) : (
        <table className="report-table mt-5">
          <tbody>
            <SectionHeader title="Operating activities" />
            {report.operating.map((row) => (
              <tr key={row.label}>
                <td colSpan={2}>{row.label}</td>
                <td className="text-right font-tabular">{money(row.amount)}</td>
              </tr>
            ))}
            <TotalRow label="Net cash from operating" amount={report.netOperating} />

            <SectionHeader title="Investing activities" />
            <tr>
              <td colSpan={2} className="text-muted">
                —
              </td>
              <td className="text-right font-tabular">{money(report.netInvesting)}</td>
            </tr>

            <SectionHeader title="Financing activities" />
            <tr>
              <td colSpan={2} className="text-muted">
                Other cash changes
              </td>
              <td className="text-right font-tabular">{money(report.netFinancing)}</td>
            </tr>

            <TotalRow label="Net change in cash" amount={report.netChangeInCash} emphasis />
            <TotalRow label="Beginning cash" amount={report.beginningCash} />
            <TotalRow label="Ending cash" amount={report.endingCash} emphasis />
          </tbody>
        </table>
      )}
    </article>
  );
}

function AgingTab({
  title,
  report,
  entityLabel,
}: {
  title: string;
  report: AgingReport;
  entityLabel: string;
}) {
  return (
    <article className="report-sheet card p-5">
      <div className="border-b border-rule pb-4">
        <h2 className="font-ledger text-2xl text-navy">{title}</h2>
        <p className="mt-1 text-sm text-muted">
          Open balances by due date · total {money(report.total)}
        </p>
      </div>

      {report.total === 0 ? (
        <p className="mt-6 text-sm text-muted">No open balances in this report.</p>
      ) : (
        <>
          <table className="report-table mt-5">
            <thead>
              <tr>
                <th>Bucket</th>
                <th>Count</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {report.buckets.map((row) => (
                <tr key={row.id}>
                  <td>{row.label}</td>
                  <td className="font-tabular text-muted">{row.count}</td>
                  <td className="text-right font-tabular">{money(row.amount)}</td>
                </tr>
              ))}
              <tr className="report-total-row">
                <td>Total</td>
                <td />
                <td className="text-right font-tabular">{money(report.total)}</td>
              </tr>
            </tbody>
          </table>

          {report.topCustomers.length > 0 ? (
            <>
              <h3 className="font-ledger mt-8 text-lg text-navy">Top {entityLabel.toLowerCase()}s</h3>
              <table className="report-table mt-3">
                <thead>
                  <tr>
                    <th>{entityLabel}</th>
                    <th className="text-right">Current</th>
                    <th className="text-right">1–30</th>
                    <th className="text-right">31–60</th>
                    <th className="text-right">61–90</th>
                    <th className="text-right">90+</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {report.topCustomers.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td className="text-right font-tabular">{money(row.buckets.current)}</td>
                      <td className="text-right font-tabular">{money(row.buckets["1_30"])}</td>
                      <td className="text-right font-tabular">{money(row.buckets["31_60"])}</td>
                      <td className="text-right font-tabular">{money(row.buckets["61_90"])}</td>
                      <td className="text-right font-tabular">{money(row.buckets["90_plus"])}</td>
                      <td className="text-right font-tabular">{money(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </>
      )}
    </article>
  );
}

function ProfitLossTable({ report }: { report: ProfitAndLoss }) {
  const empty =
    report.totalRevenue === 0 && report.totalCogs === 0 && report.totalExpenses === 0;

  if (empty) {
    return (
      <p className="mt-6 text-sm text-muted">
        No revenue or expense activity posted yet. Post invoices and expenses to populate the P&amp;L.
      </p>
    );
  }

  return (
    <table className="report-table mt-5">
      <tbody>
        <SectionHeader title="Revenue" />
        {report.revenue.map((row) => (
          <PLRow key={row.code} code={row.code} name={row.name} amount={row.amount} />
        ))}
        <TotalRow label="Total revenue" amount={report.totalRevenue} />

        <SectionHeader title="Cost of goods sold" />
        {report.cogs.length === 0 ? (
          <EmptyRow />
        ) : (
          report.cogs.map((row) => (
            <PLRow key={row.code} code={row.code} name={row.name} amount={row.amount} />
          ))
        )}
        <TotalRow label="Total COGS" amount={report.totalCogs} />
        <TotalRow label="Gross profit" amount={report.grossProfit} emphasis />

        <SectionHeader title="Operating expenses" />
        {report.expenses.map((row) => (
          <PLRow key={row.code} code={row.code} name={row.name} amount={row.amount} />
        ))}
        <TotalRow label="Total expenses" amount={report.totalExpenses} />
        <TotalRow label="Net income" amount={report.netIncome} emphasis />
      </tbody>
    </table>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <tr className="report-section-row">
      <td colSpan={3}>{title}</td>
    </tr>
  );
}

function PLRow({ code, name, amount }: { code: string; name: string; amount: number }) {
  return (
    <tr>
      <td className="w-16 font-tabular text-muted">{code}</td>
      <td>{name}</td>
      <td className="text-right font-tabular">{money(amount)}</td>
    </tr>
  );
}

function FinancialRow({ code, name, amount }: { code: string; name: string; amount: number }) {
  return (
    <tr>
      <td className="w-16 font-tabular text-muted">{code}</td>
      <td>{name}</td>
      <td className="text-right font-tabular">{money(amount)}</td>
    </tr>
  );
}

function EmptyRow() {
  return (
    <tr>
      <td colSpan={2} className="text-muted">
        —
      </td>
      <td className="text-right font-tabular">$0.00</td>
    </tr>
  );
}

function TotalRow({
  label,
  amount,
  emphasis = false,
}: {
  label: string;
  amount: number;
  emphasis?: boolean;
}) {
  return (
    <tr className={emphasis ? "report-total-row" : "report-subtotal-row"}>
      <td colSpan={2}>{label}</td>
      <td className="text-right font-tabular">{money(amount)}</td>
    </tr>
  );
}

function Bar({
  amount,
  max,
  tone,
}: {
  amount: number;
  max: number;
  tone: "navy" | "brass";
}) {
  const width = Math.max(2, Math.round((amount / max) * 100));
  return (
    <div className="h-2 rounded bg-paper">
      <div
        className={`h-2 rounded ${tone === "navy" ? "bg-navy" : "bg-brass"}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
