export const OWNER_MODE_PLANNING_LABELS: Record<string, string> = {
  Budget: "Plan",
  "Annual Plan": "Annual plan",
  "Monthly Plan": "Monthly plan",
  "Vs Plan": "Vs plan",
  "Budget vs Actual": "How you're doing vs plan",
  Forecast: "What the next months look like",
  "Cash outlook": "Cash outlook",
  "Create Revision": "Create new plan version",
  "Approved version": "Approved plan",
  "Locked version": "Locked plan",
  Draft: "Draft",
  Scenarios: "What-if scenarios",
  "Expected Revenue": "Expected revenue",
  "Expected Operating Income": "Expected profit",
  "13-Week Cash Outlook": "Cash outlook (13 weeks)",
  "Lowest Projected Cash": "Lowest cash",
  "Downside Outlook": "Downside outlook",
  "Needs Attention": "Needs attention",
};

export function planningOwnerLabel(accountantLabel: string): string {
  return OWNER_MODE_PLANNING_LABELS[accountantLabel] ?? accountantLabel;
}
