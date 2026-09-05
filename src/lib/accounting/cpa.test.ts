import { describe, expect, it } from "vitest";
import { canExportBooks, canManagePeriodClose, parseCpaMode } from "./cpa";

describe("parseCpaMode", () => {
  it("accepts common truthy values", () => {
    expect(parseCpaMode(true)).toBe(true);
    expect(parseCpaMode("true")).toBe(true);
    expect(parseCpaMode("no")).toBe(false);
  });
});

describe("canExportBooks", () => {
  it("allows viewers when CPA mode is enabled", () => {
    expect(canExportBooks("viewer", true)).toBe(true);
  });

  it("blocks viewers when CPA mode is off", () => {
    expect(canExportBooks("viewer", false)).toBe(false);
    expect(canExportBooks("bookkeeper", false)).toBe(true);
  });
});

describe("canManagePeriodClose", () => {
  it("limits close actions to owners and admins", () => {
    expect(canManagePeriodClose("owner")).toBe(true);
    expect(canManagePeriodClose("bookkeeper")).toBe(false);
  });
});
