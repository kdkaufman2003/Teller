import { titleCase } from "@/lib/format";

const TONES: Record<string, string> = {
  draft: "bg-rule/60 text-muted",
  open: "bg-sky/15 text-sky",
  partially_paid: "bg-brass/15 text-brass-deep",
  partially_applied: "bg-brass/15 text-brass-deep",
  applied: "bg-ok/15 text-ok",
  paid: "bg-ok/15 text-ok",
  void: "bg-danger/10 text-danger",
  estimate: "bg-brass/15 text-brass-deep",
  scheduled: "bg-sky/15 text-sky",
  in_progress: "bg-navy/10 text-navy",
  complete: "bg-ok/15 text-ok",
  invoiced: "bg-ok/15 text-ok",
  cancelled: "bg-danger/10 text-danger",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
        TONES[status] || "bg-rule/60 text-muted"
      }`}
    >
      {titleCase(status)}
    </span>
  );
}
