import { describe, expect, it } from "vitest";
import { conditionsMatch } from "./conditions";
import { determineInvoiceTaxFromRuleSet, determineLineTax } from "./engine";
import { parseTaxRuleSetSpec, ruleSetIsEffective } from "./spec";
import { resolveTaxRate } from "./rates";
import type { LoadedTaxRuleSet } from "./types";

/** Generic fixture — not a real jurisdiction. Tests engine mechanics only. */
const FIXTURE_RULE_SET: LoadedTaxRuleSet = {
  slug: "fixture-demo-v1",
  name: "Engine fixture rule set",
  version: "2099-01-01",
  status: "active",
  effectiveFrom: "2099-01-01",
  sourceDocumentation: "Internal engine test fixture only",
  rates: [
    {
      jurisdictionKey: "FIXTURE-CITY",
      ratePercent: 7.5,
      rateType: "sales_tax",
      effectiveFrom: "2099-01-01",
      sourceCitation: "Fixture citation",
    },
  ],
  rules: [
    {
      ruleKey: "equipment-taxable",
      priority: 10,
      conditions: {
        all: [{ field: "line.itemType", op: "eq", value: "equipment" }],
      },
      action: {
        treatment: "taxable",
        jurisdictionKey: "FIXTURE-CITY",
      },
    },
    {
      ruleKey: "labor-exempt",
      priority: 20,
      conditions: {
        all: [{ field: "line.itemType", op: "eq", value: "labor" }],
      },
      action: {
        treatment: "exempt",
        reason: "Fixture exempt labor",
      },
    },
  ],
};

describe("conditionsMatch", () => {
  it("matches all/any condition groups", () => {
    const context = {
      transactionDate: "2099-06-01",
      businessLocation: { country: "US", state: "XX", county: "", city: "", postalCode: "" },
      line: {
        lineKey: "0",
        description: "Unit",
        amount: 100,
        itemType: "equipment",
      },
    };

    expect(
      conditionsMatch(context, {
        all: [{ field: "line.itemType", op: "eq", value: "equipment" }],
      }),
    ).toBe(true);

    expect(
      conditionsMatch(context, {
        any: [{ field: "line.itemType", op: "eq", value: "labor" }],
      }),
    ).toBe(false);
  });
});

describe("determineLineTax", () => {
  it("applies the first matching rule by priority", () => {
    const equipment = determineLineTax(FIXTURE_RULE_SET, {
      transactionDate: "2099-06-01",
      businessLocation: { country: "US", state: "XX" },
      line: {
        lineKey: "0",
        description: "Condenser",
        amount: 1000,
        itemType: "equipment",
      },
    });

    expect(equipment.taxTreatment).toBe("taxable");
    expect(equipment.taxAmount).toBe(75);
    expect(equipment.ruleKey).toBe("equipment-taxable");
  });

  it("returns exempt when matched", () => {
    const labor = determineLineTax(FIXTURE_RULE_SET, {
      transactionDate: "2099-06-01",
      businessLocation: { country: "US", state: "XX" },
      line: {
        lineKey: "1",
        description: "Install labor",
        amount: 500,
        itemType: "labor",
      },
    });

    expect(labor.taxTreatment).toBe("exempt");
    expect(labor.taxAmount).toBe(0);
  });
});

describe("determineInvoiceTaxFromRuleSet", () => {
  it("totals mixed line determinations", () => {
    const result = determineInvoiceTaxFromRuleSet(FIXTURE_RULE_SET, {
      transactionDate: "2099-06-01",
      businessLocation: { country: "US", state: "XX" },
      lines: [
        {
          lineKey: "0",
          description: "Equipment",
          amount: 1000,
          itemType: "equipment",
        },
        {
          lineKey: "1",
          description: "Labor",
          amount: 500,
          itemType: "labor",
        },
      ],
    });

    expect(result.subtotal).toBe(1500);
    expect(result.tax).toBe(75);
    expect(result.total).toBe(1575);
  });
});

describe("ruleSetIsEffective", () => {
  it("requires active status and in-range dates", () => {
    expect(
      ruleSetIsEffective(
        { status: "active", effectiveFrom: "2099-01-01", effectiveTo: null },
        "2099-06-01",
      ),
    ).toBe(true);

    expect(
      ruleSetIsEffective(
        { status: "draft", effectiveFrom: "2099-01-01", effectiveTo: null },
        "2099-06-01",
      ),
    ).toBe(false);
  });
});

describe("parseTaxRuleSetSpec", () => {
  it("validates rule set JSON structure", () => {
    const parsed = parseTaxRuleSetSpec({
      slug: "fixture",
      name: "Fixture",
      version: "1",
      status: "draft",
      effectiveFrom: "2099-01-01",
      rules: [
        {
          ruleKey: "r1",
          priority: 1,
          conditions: {},
          action: { treatment: "non_taxable", reason: "test" },
        },
      ],
    });

    expect(parsed.slug).toBe("fixture");
  });
});

describe("resolveTaxRate", () => {
  it("selects the latest effective rate for a date", () => {
    const rate = resolveTaxRate(
      [
        {
          jurisdictionKey: "FIXTURE-CITY",
          ratePercent: 6,
          rateType: "sales_tax",
          effectiveFrom: "2099-01-01",
          sourceCitation: "old",
        },
        {
          jurisdictionKey: "FIXTURE-CITY",
          ratePercent: 7,
          rateType: "sales_tax",
          effectiveFrom: "2099-04-01",
          sourceCitation: "new",
        },
      ],
      { jurisdictionKey: "FIXTURE-CITY", transactionDate: "2099-06-01" },
    );

    expect(rate?.ratePercent).toBe(7);
  });
});
