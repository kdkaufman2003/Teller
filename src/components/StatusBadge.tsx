import { titleCase } from "@/lib/format";

const TONES: Record<string, string> = {
  draft: "bg-surface text-muted",
  open: "bg-accent-soft text-accent",
  paid: "bg-success-soft text-success",
  void: "bg-red-50 text-danger",
  estimate: "bg-surface text-muted",
  scheduled: "bg-accent-soft text-accent",
  in_progress: "bg-accent-soft text-accent",
  complete: "bg-success-soft text-success",
  invoiced: "bg-success-soft text-success",
  cancelled: "bg-red-50 text-danger",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
        TONES[status] || "bg-surface text-muted"
      }`}
    >
      {titleCase(status)}
    </span>
  );
}
