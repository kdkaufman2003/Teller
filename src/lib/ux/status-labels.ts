/** Consistent user-facing status language across lists. */
export function userFacingStatus(status: string): string {
  const map: Record<string, string> = {
    open: "Open",
    partially_paid: "Partially paid",
    paid: "Paid",
    void: "Void",
    voided: "Voided",
    draft: "Draft",
    posted: "Posted",
    reversed: "Reversed",
    unmatched: "Needs review",
    suggested: "Suggested match",
    matched: "Matched",
    ignored: "Ignored",
    excluded: "Excluded",
    in_progress: "In progress",
    completed: "Completed",
    cancelled: "Cancelled",
    closed: "Closed",
    estimate: "Estimate",
    scheduled: "Scheduled",
    pending: "Pending",
    failed: "Failed",
    processed: "Processed",
  };
  return map[status] ?? status.replace(/_/g, " ");
}
