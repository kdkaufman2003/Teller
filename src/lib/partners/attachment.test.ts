import { describe, expect, it } from "vitest";
import {
  applyPartnerSetupDefaults,
  ensureQuoterModule,
  partnerIdFromAnswers,
} from "./attachment";

describe("partner attachment", () => {
  it("standalone mode does not attach a partner", () => {
    expect(partnerIdFromAnswers({ deploymentMode: "standalone" })).toBeNull();
    expect(applyPartnerSetupDefaults(null, { connectQuoter: true }).connectQuoter).toBe(
      false,
    );
  });

  it("attached mode enables quoter defaults", () => {
    expect(partnerIdFromAnswers({ deploymentMode: "attached" })).toBe("hasslefreeac");
    const answers = applyPartnerSetupDefaults("hasslefreeac", {});
    expect(answers.connectQuoter).toBe(true);
    expect(answers.customerNoun).toBe("dealers");
  });

  it("adds quoter module when attached", () => {
    const modules = ensureQuoterModule(["dashboard", "invoices"], "hasslefreeac");
    expect(modules).toContain("quoter");
  });

  it("does not add quoter module when standalone", () => {
    const modules = ensureQuoterModule(["dashboard", "invoices"], null);
    expect(modules).not.toContain("quoter");
  });
});
