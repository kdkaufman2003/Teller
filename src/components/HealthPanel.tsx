import Link from "next/link";
import { computeHealthReport, formatHealthGrade } from "@/lib/health/engine";
import type { HealthReport } from "@/lib/health/types";

function scoreColor(score: number): string {
  if (score >= 85) return "text-emerald-700";
  if (score >= 65) return "text-amber-700";
  return "text-red-700";
}

function ringColor(score: number): string {
  if (score >= 85) return "stroke-emerald-500";
  if (score >= 65) return "stroke-amber-500";
  return "stroke-red-500";
}

function severityClass(severity: HealthReport["attention"][number]["severity"]): string {
  if (severity === "critical") return "border-red-200 bg-red-50";
  if (severity === "warning") return "border-amber-200 bg-amber-50";
  return "border-sky-100 bg-sky-50";
}

export function HealthPanel({ report }: { report: HealthReport }) {
  const circumference = 2 * Math.PI * 42;
  const offset = circumference - (report.score / 100) * circumference;

  return (
    <section className="card p-5">
      <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
        <div className="flex items-center gap-4">
          <div className="relative h-24 w-24 shrink-0">
            <svg viewBox="0 0 100 100" className="h-24 w-24 -rotate-90">
              <circle cx="50" cy="50" r="42" fill="none" strokeWidth="8" className="stroke-rule" />
              <circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                className={ringColor(report.score)}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={`font-ledger text-2xl font-tabular ${scoreColor(report.score)}`}>
                {report.score}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-muted">Health</span>
            </div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-muted">Bookkeeping health</p>
            <p className="font-ledger mt-1 text-xl text-navy">{formatHealthGrade(report.grade)}</p>
            <p className="mt-1 text-sm text-muted">{report.headline}</p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {report.factors.map((factor) => (
            <div key={factor.id} className="rounded-lg border border-rule px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{factor.label}</span>
                <span className={`font-tabular ${scoreColor(factor.score)}`}>{factor.score}</span>
              </div>
              <p className="mt-1 text-xs text-muted">{factor.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {report.attention.length > 0 ? (
        <div className="mt-6 border-t border-rule pt-5">
          <h2 className="font-ledger text-lg text-navy">Needs attention</h2>
          <ul className="mt-3 space-y-2">
            {report.attention.map((item) => (
              <li key={item.id}>
                {item.href ? (
                  <Link
                    href={item.href}
                    className={`block rounded-lg border px-4 py-3 transition hover:opacity-90 ${severityClass(item.severity)}`}
                  >
                    <p className="font-medium">{item.title}</p>
                    <p className="text-sm text-muted">{item.description}</p>
                  </Link>
                ) : (
                  <div className={`rounded-lg border px-4 py-3 ${severityClass(item.severity)}`}>
                    <p className="font-medium">{item.title}</p>
                    <p className="text-sm text-muted">{item.description}</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
