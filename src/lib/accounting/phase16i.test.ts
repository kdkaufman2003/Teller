import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  companyBooksLabel,
  closeReadinessUserMessage,
  ENTITY_CONTROL_USER_MESSAGES,
} from "@/lib/legal-entity/ux";
import { routes } from "@/lib/routes";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

describe("Phase 16I UX terminology", () => {
  it("formats company books label with optional code", () => {
    expect(companyBooksLabel("ABC Heating")).toBe("ABC Heating");
    expect(companyBooksLabel("ABC Heating", "HTG")).toBe("ABC Heating (HTG)");
  });

  it("translates close readiness keys to owner-friendly messages", () => {
    expect(
      closeReadinessUserMessage({
        key: "ar_control",
        title: "AR_CONTROL_MISMATCH",
        description: "raw",
      }),
    ).toBe("Accounts receivable does not match the general ledger.");
    expect(
      closeReadinessUserMessage({
        key: "ap",
        title: "AP",
        description: "raw",
      }),
    ).toBe("Accounts payable does not match the general ledger.");
  });

  it("exposes safe entity error copy", () => {
    expect(ENTITY_CONTROL_USER_MESSAGES.unauthorized).toMatch(/access/i);
    expect(ENTITY_CONTROL_USER_MESSAGES.archived).toMatch(/archived/i);
    expect(ENTITY_CONTROL_USER_MESSAGES.closedPeriod("ABC Heating")).toMatch(/ABC Heating/);
  });
});

describe("Phase 16I navigation routes", () => {
  it("defines All Companies and accountant workspace routes", () => {
    expect(routes.companiesOverview).toBe("/app/companies");
    expect(routes.accountingWorkspace).toBe("/app/accounting/workspace");
    expect(routes.reportsConsolidated).toBe("/app/reports/consolidated");
  });
});

describe("Phase 16I UI wiring (static)", () => {
  it("remounts main content on entity switch", () => {
    const shell = readSource("src/components/AppShell.tsx");
    expect(shell).toMatch(/key=\{activeLegalEntity\?\.id/);
  });

  it("entity switcher links to overview and consolidated reports", () => {
    const switcher = readSource("src/components/legal-entity/EntitySwitcher.tsx");
    expect(switcher).toMatch(/companiesOverview/);
    expect(switcher).toMatch(/reportsConsolidated/);
    expect(switcher).toMatch(/Your books are set up for one company/);
  });

  it("does not expose All Companies as a posting API", () => {
    const companiesPage = readSource("src/app/app/companies/page.tsx");
    expect(companiesPage).not.toMatch(/postJournal|requireEntityBooks/);
    expect(companiesPage).toMatch(/Consolidated reports/);
  });

  it("scopes company reports to active entity", () => {
    const reportsPage = readSource("src/app/app/reports/page.tsx");
    expect(reportsPage).toMatch(/legalEntityId/);
    expect(reportsPage).toMatch(/Company reports/);
    expect(reportsPage).toMatch(/CompanyContextHeader/);
  });

  it("scopes dashboard metrics to active entity", () => {
    const dashboard = readSource("src/app/app/page.tsx");
    expect(dashboard).toMatch(/legal_entity_id/);
    expect(dashboard).toMatch(/CompanyContextHeader/);
  });

  it("report engine filters by legal entity", () => {
    const engine = readSource("src/lib/accounting/report-engine.ts");
    expect(engine).toMatch(/ReportEngineOptions/);
    expect(engine).toMatch(/resolveLegalEntityId/);
    expect(engine).toMatch(/totalsForAccounts/);
  });

  it("new company setup copy forbids copying history", () => {
    const admin = readSource("src/components/legal-entity/EntityAdminPanel.tsx");
    expect(admin).toMatch(/structure only/);
    expect(admin).toMatch(/never balances or[\s\S]*history/i);
  });
});

describe("Phase 16I accounting semantics unchanged", () => {
  it("does not alter post.ts entity resolution", () => {
    const post = readSource("src/lib/accounting/post.ts");
    expect(post).toMatch(/resolvePostingLegalEntityId/);
    expect(post).not.toMatch(/ALL_COMPANIES/);
  });
});
