import { describe, expect, it } from "vitest";
import {
  applyPartnerSetupDefaults,
  ensureHfacModule,
  partnerIdFromAnswers,
} from "./attachment";

describe("partner attachment", () => {
  it("standalone mode does not attach a partner", () => {
    expect(partnerIdFromAnswers({ deploymentMode: "standalone" })).toBeNull();
    expect(applyPartnerSetupDefaults(null, { connectHfac: true }).connectHfac).toBe(
      false,
    );
  });

  it("attached mode enables HFAC defaults", () => {
    expect(partnerIdFromAnswers({ deploymentMode: "attached" })).toBe("hasslefreeac");
    const answers = applyPartnerSetupDefaults("hasslefreeac", {});
    expect(answers.connectHfac).toBe(true);
    expect(answers.customerNoun).toBe("dealers");
  });

  it("adds hfac module when attached", () => {
    const modules = ensureHfacModule(["dashboard", "invoices"], "hasslefreeac");
    expect(modules).toContain("hfac");
  });

  it("does not add hfac module when standalone", () => {
    const modules = ensureHfacModule(["dashboard", "invoices"], null);
    expect(modules).not.toContain("hfac");
  });
});
