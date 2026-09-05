import { describe, expect, it } from "vitest";
import { getIndustryPack } from "./registry";
import {
  applyBusinessModelDefaults,
  collectTaxOn,
  isQuestionVisible,
  questionsBySection,
  visibleQuestions,
} from "./onboarding";

describe("onboarding branching", () => {
  it("hides tax rate when sales tax is off", () => {
    const pack = getIndustryPack("trades-hvac");
    const answers = { collectTax: false, taxRate: 8 };
    expect(isQuestionVisible(pack.questions.find((q) => q.id === "taxRate")!, answers)).toBe(
      false,
    );
    expect(visibleQuestions(pack, answers).some((q) => q.id === "taxRate")).toBe(false);
  });

  it("shows tax rate when sales tax is on", () => {
    const pack = getIndustryPack("trades-hvac");
    const answers = { collectTax: true };
    expect(visibleQuestions(pack, answers).some((q) => q.id === "taxRate")).toBe(true);
  });

  it("applies business model defaults for service shops", () => {
    const next = applyBusinessModelDefaults("service", {});
    expect(next.revenueStreams).toContain("service");
    expect(next.trackJobs).toBe(true);
    expect(next.trackInventory).toBe(false);
  });

  it("groups visible questions into sections", () => {
    const pack = getIndustryPack("general");
    const sections = questionsBySection(pack, { collectTax: false });
    expect(sections.some((group) => group.section === "accounting")).toBe(true);
    expect(collectTaxOn({ collectTax: true })).toBe(true);
  });

  it("includes HVAC market segment question", () => {
    const pack = getIndustryPack("trades-hvac");
    expect(pack.questions.some((q) => q.id === "marketSegments")).toBe(true);
  });
});
