import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mapUserFacingError } from "./user-errors";
import { navItemsForMode } from "./navigation";
import { resolvePresentationMode, defaultPresentationModeForRole } from "./presentation-mode";
import { userFacingStatus } from "./status-labels";
import { presentLabel } from "@/lib/accounting/presentation-mode";

describe("Phase 17F UX", () => {
  it("maps accounting errors to plain language", () => {
    expect(mapUserFacingError("PERIOD_CLOSED for 2024-12-31")).toContain("period is closed");
    expect(mapUserFacingError("ACCOUNTING_STATE_CHANGED")).toContain("Refresh");
  });

  it("defaults owner role to owner presentation mode", () => {
    expect(defaultPresentationModeForRole("owner")).toBe("owner");
    expect(defaultPresentationModeForRole("bookkeeper")).toBe("accountant");
  });

  it("resolves presentation mode from cookie", () => {
    expect(
      resolvePresentationMode({ role: "bookkeeper", cookieMode: "owner" }),
    ).toBe("owner");
  });

  it("owner nav hides accountant-only items", () => {
    const ownerNav = navItemsForMode("owner", ["jobs"], {});
    const accountantNav = navItemsForMode("accountant", ["jobs"], {});
    expect(ownerNav.some((i) => i.href.includes("/accounting/workspace"))).toBe(false);
    expect(accountantNav.some((i) => i.href.includes("/accounting/workspace"))).toBe(true);
  });

  it("owner terminology preserves accountant labels in accountant mode", () => {
    expect(presentLabel("accountant", "Accounts Receivable")).toBe("Accounts Receivable");
    expect(presentLabel("owner", "Accounts Receivable")).toBe("Customers owe you");
  });

  it("status labels include text not color-only", () => {
    expect(userFacingStatus("partially_paid")).toBe("Partially paid");
    expect(userFacingStatus("unmatched")).toBe("Needs review");
  });

  it("report engine uses authoritative remaining for aging", () => {
    const engine = readFileSync(
      join(process.cwd(), "src/lib/accounting/report-engine.ts"),
      "utf8",
    );
    expect(engine).toContain("batchAuthoritativeDocumentRemaining");
    expect(engine).not.toContain("amount_paid: 0,\n    party_id: null");
  });

  it("ux deliverables exist", () => {
    expect(existsSync(join(process.cwd(), "docs/PHASE-17F-UX-AUDIT.md"))).toBe(true);
    expect(existsSync(join(process.cwd(), "src/components/ui/EmptyState.tsx"))).toBe(true);
    expect(existsSync(join(process.cwd(), "src/app/api/ux/presentation-mode/route.ts"))).toBe(true);
  });
});
