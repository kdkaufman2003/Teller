import type { ScenarioDriverInput, ScenarioType } from "./types";

export const DOWNSIDE_TEMPLATE_DRIVERS: ScenarioDriverInput[] = [
  { driverType: "revenue_percentage", valueNumeric: -10 },
  { driverType: "gross_margin_points", valueNumeric: -2 },
  { driverType: "expense_percentage", valueNumeric: 5 },
  { driverType: "ar_days_adjustment", valueNumeric: 10 },
  { driverType: "ap_days_adjustment", valueNumeric: 0 },
  { driverType: "payroll_percentage", valueNumeric: 0 },
  { driverType: "purchasing_percentage", valueNumeric: -10 },
  { driverType: "capex_percentage", valueNumeric: -25 },
];

export const UPSIDE_TEMPLATE_DRIVERS: ScenarioDriverInput[] = [
  { driverType: "revenue_percentage", valueNumeric: 10 },
  { driverType: "gross_margin_points", valueNumeric: 2 },
  { driverType: "expense_percentage", valueNumeric: 0 },
  { driverType: "ar_days_adjustment", valueNumeric: -5 },
  { driverType: "ap_days_adjustment", valueNumeric: 0 },
  { driverType: "payroll_percentage", valueNumeric: 0 },
  { driverType: "purchasing_percentage", valueNumeric: 0 },
  { driverType: "capex_percentage", valueNumeric: 0 },
];

export function defaultDriversForScenarioType(scenarioType: ScenarioType): ScenarioDriverInput[] {
  if (scenarioType === "downside") return [...DOWNSIDE_TEMPLATE_DRIVERS];
  if (scenarioType === "upside") return [...UPSIDE_TEMPLATE_DRIVERS];
  return [];
}

export function defaultScenarioName(scenarioType: ScenarioType): string {
  switch (scenarioType) {
    case "base":
      return "Base Plan";
    case "downside":
      return "Downside";
    case "upside":
      return "Upside";
    default:
      return "Custom Scenario";
  }
}
