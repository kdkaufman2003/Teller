import { BudgetVsActualReportView } from "@/components/planning/BudgetVsActualReportView";
import { fiscalYearCalendarMonths, isValidPeriodMonth } from "@/lib/planning/budgets/periods";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

type PageProps = {
  searchParams: Promise<{
    fiscalYear?: string;
    throughMonth?: string;
    versionId?: string;
  }>;
};

export default async function BudgetVsActualPage({ searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const params = await searchParams;
  const fiscalYear = Number(params.fiscalYear ?? new Date().getFullYear() + 1);
  const months = fiscalYearCalendarMonths(Number.isFinite(fiscalYear) ? fiscalYear : new Date().getFullYear() + 1);
  const today = new Date();
  const defaultMonth = `${fiscalYear}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const throughMonth =
    params.throughMonth && isValidPeriodMonth(params.throughMonth) && months.includes(params.throughMonth)
      ? params.throughMonth
      : months.includes(defaultMonth)
        ? defaultMonth
        : months[0]!;

  return (
    <div className="p-6">
      <BudgetVsActualReportView
        initialFiscalYear={fiscalYear}
        initialThroughMonth={throughMonth}
        initialVersionId={params.versionId}
      />
    </div>
  );
}
