import type { ScenarioDriverInput, ScenarioDriverType, ScenarioType } from "./types";

const DRIVER_TYPES = new Set<ScenarioDriverType>([
  "revenue_percentage",
  "cogs_percentage",
  "expense_percentage",
  "gross_margin_points",
  "ar_days_adjustment",
  "ap_days_adjustment",
  "payroll_percentage",
  "purchasing_percentage",
  "capex_percentage",
  "note",
]);

const PERCENT_DRIVERS = new Set<ScenarioDriverType>([
  "revenue_percentage",
  "cogs_percentage",
  "expense_percentage",
  "payroll_percentage",
  "purchasing_percentage",
  "capex_percentage",
]);

const DAY_DRIVERS = new Set<ScenarioDriverType>([
  "ar_days_adjustment",
  "ap_days_adjustment",
]);

export function validateScenarioName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Scenario name is required");
  if (trimmed.length > 120) throw new Error("Scenario name is too long");
}

export function validateScenarioType(value: string): ScenarioType {
  if (value === "base" || value === "downside" || value === "upside" || value === "custom") {
    return value;
  }
  throw new Error("Invalid scenario type");
}

export function validateScenarioDrivers(drivers: ScenarioDriverInput[]): void {
  const seen = new Set<ScenarioDriverType>();
  let hasCogsPct = false;
  let hasMarginPoints = false;

  for (const driver of drivers) {
    if (!DRIVER_TYPES.has(driver.driverType)) {
      throw new Error(`Unsupported driver type: ${driver.driverType}`);
    }
    if (seen.has(driver.driverType)) {
      throw new Error(`Duplicate driver type: ${driver.driverType}`);
    }
    seen.add(driver.driverType);

    if (driver.driverType === "note") continue;

    const value = driver.valueNumeric;
    if (value == null || !Number.isFinite(Number(value))) {
      throw new Error(`${driver.driverType} requires a numeric value`);
    }

    if (PERCENT_DRIVERS.has(driver.driverType)) {
      if (Math.abs(Number(value)) > 100) {
        throw new Error(`${driver.driverType} must be between -100 and 100`);
      }
    }

    if (DAY_DRIVERS.has(driver.driverType)) {
      if (Math.abs(Number(value)) > 365) {
        throw new Error(`${driver.driverType} day shift is too large`);
      }
    }

    if (driver.driverType === "gross_margin_points") {
      hasMarginPoints = true;
      if (Math.abs(Number(value)) > 50) {
        throw new Error("gross_margin_points must be between -50 and 50");
      }
    }
    if (driver.driverType === "cogs_percentage") hasCogsPct = true;
  }

  if (hasCogsPct && hasMarginPoints) {
    throw new Error("Cannot combine cogs_percentage with gross_margin_points");
  }
}

export function validateCashAdjustment(input: {
  effectiveDate: string;
  flowKind: string;
  amount: number;
  label: string;
}): void {
  if (!input.effectiveDate?.slice(0, 10)) throw new Error("Effective date is required");
  if (input.flowKind !== "inflow" && input.flowKind !== "outflow") {
    throw new Error("flowKind must be inflow or outflow");
  }
  if (input.amount <= 0) throw new Error("Amount must be positive");
  if (!input.label.trim()) throw new Error("Description is required");
}
