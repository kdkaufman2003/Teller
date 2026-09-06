import { describe, expect, it } from "vitest";
import {
  createIntegrationClient,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

const describeIntegration = integrationTestsEnabled() ? describe : describe.skip;

describeIntegration("Phase 5A banking schema", () => {
  it("links asset bank account to same-org GL cash account", async () => {
    const supabase = createIntegrationClient();
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p5-asset");

    try {
      const { data: connection, error: connectionError } = await supabase
        .from("teller_bank_connections")
        .insert({
          organization_id: organizationId,
          provider: "manual_csv",
          external_item_id: `manual-${Date.now()}`,
          institution_name: "Test Bank",
        })
        .select("id")
        .single();
      expect(connectionError).toBeNull();
      expect(connection?.id).toBeTruthy();

      const { data: bankAccount, error: bankError } = await supabase
        .from("teller_bank_accounts")
        .insert({
          organization_id: organizationId,
          connection_id: connection!.id,
          external_account_id: `acct-${Date.now()}`,
          name: "Operating Checking",
          account_type: "depository",
          account_subtype: "checking",
          gl_account_id: accountIds["1000"],
        })
        .select("id, gl_account_id, teller_account_id")
        .single();

      expect(bankError).toBeNull();
      expect(bankAccount?.gl_account_id).toBe(accountIds["1000"]);
      expect(bankAccount?.teller_account_id).toBe(accountIds["1000"]);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("links credit card feed to same-org liability GL account", async () => {
    const supabase = createIntegrationClient();
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p5-cc");

    const { data: liability, error: liabilityError } = await supabase
      .from("teller_accounts")
      .insert({
        organization_id: organizationId,
        code: "2100",
        name: "Business Credit Card",
        type: "liability",
        subtype: "credit_card",
        is_system: true,
      })
      .select("id")
      .single();
    expect(liabilityError).toBeNull();

    try {
      const { data: connection } = await supabase
        .from("teller_bank_connections")
        .insert({
          organization_id: organizationId,
          provider: "manual_csv",
          external_item_id: `cc-${Date.now()}`,
          institution_name: "Card Issuer",
        })
        .select("id")
        .single();

      const { error: bankError } = await supabase.from("teller_bank_accounts").insert({
        organization_id: organizationId,
        connection_id: connection!.id,
        external_account_id: `cc-acct-${Date.now()}`,
        name: "Visa Business",
        account_type: "credit",
        account_subtype: "credit card",
        gl_account_id: liability!.id,
      });

      expect(bankError).toBeNull();
      expect(accountIds["1000"]).toBeTruthy();
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("rejects cross-org bank-to-GL linkage", async () => {
    const supabase = createIntegrationClient();
    const orgA = await createTestOrganization(supabase, "p5-org-a");
    const orgB = await createTestOrganization(supabase, "p5-org-b");

    try {
      const { data: connection } = await supabase
        .from("teller_bank_connections")
        .insert({
          organization_id: orgA.organizationId,
          provider: "manual_csv",
          external_item_id: `xorg-${Date.now()}`,
        })
        .select("id")
        .single();

      const { error } = await supabase.from("teller_bank_accounts").insert({
        organization_id: orgA.organizationId,
        connection_id: connection!.id,
        external_account_id: `xorg-acct-${Date.now()}`,
        name: "Bad Link",
        account_type: "depository",
        account_subtype: "checking",
        gl_account_id: orgB.accountIds["1000"],
      });

      expect(error).toBeTruthy();
      expect(error!.message.toLowerCase()).toMatch(/organization|different/);
    } finally {
      await deleteTestOrganization(supabase, orgA.organizationId);
      await deleteTestOrganization(supabase, orgB.organizationId);
    }
  });

  it("enforces provider transaction uniqueness per bank account", async () => {
    const supabase = createIntegrationClient();
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p5-dup");

    try {
      const { data: connection } = await supabase
        .from("teller_bank_connections")
        .insert({
          organization_id: organizationId,
          provider: "manual_csv",
          external_item_id: `dup-${Date.now()}`,
        })
        .select("id")
        .single();

      const { data: bankAccount } = await supabase
        .from("teller_bank_accounts")
        .insert({
          organization_id: organizationId,
          connection_id: connection!.id,
          external_account_id: `dup-acct-${Date.now()}`,
          name: "Checking",
          gl_account_id: accountIds["1000"],
        })
        .select("id")
        .single();

      const externalId = `txn-${Date.now()}`;
      const base = {
        organization_id: organizationId,
        bank_account_id: bankAccount!.id,
        external_transaction_id: externalId,
        provider_transaction_id: externalId,
        posted_date: "2026-05-01",
        amount: -250,
        name: "Deposit",
      };

      const first = await supabase.from("teller_bank_transactions").insert(base).select("id").single();
      expect(first.error).toBeNull();

      const duplicate = await supabase.from("teller_bank_transactions").insert(base).select("id").single();
      expect(duplicate.error).toBeTruthy();
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("stores normalized amount, direction, and pending lineage fields", async () => {
    const supabase = createIntegrationClient();
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p5-norm");

    try {
      const { data: connection } = await supabase
        .from("teller_bank_connections")
        .insert({
          organization_id: organizationId,
          provider: "plaid",
          external_item_id: `norm-${Date.now()}`,
        })
        .select("id")
        .single();

      const { data: bankAccount } = await supabase
        .from("teller_bank_accounts")
        .insert({
          organization_id: organizationId,
          connection_id: connection!.id,
          external_account_id: `norm-acct-${Date.now()}`,
          name: "Checking",
          account_type: "depository",
          gl_account_id: accountIds["1000"],
        })
        .select("id")
        .single();

      const pendingId = `pending-${Date.now()}`;
      const postedId = `posted-${Date.now()}`;

      const { data: pendingTxn } = await supabase
        .from("teller_bank_transactions")
        .insert({
          organization_id: organizationId,
          bank_account_id: bankAccount!.id,
          external_transaction_id: pendingId,
          provider_pending_transaction_id: pendingId,
          posted_date: "2026-05-02",
          amount: -100,
          name: "Pending deposit",
          pending: true,
          provider_lifecycle_state: "active",
        })
        .select("normalized_amount, direction, status, provider_pending_transaction_id")
        .single();

      expect(Number(pendingTxn?.normalized_amount)).toBe(100);
      expect(pendingTxn?.direction).toBe("inflow");
      expect(pendingTxn?.status).toBe("unreviewed");
      expect(pendingTxn?.provider_pending_transaction_id).toBe(pendingId);

      const { data: postedTxn } = await supabase
        .from("teller_bank_transactions")
        .insert({
          organization_id: organizationId,
          bank_account_id: bankAccount!.id,
          external_transaction_id: postedId,
          provider_pending_transaction_id: pendingId,
          posted_date: "2026-05-03",
          amount: -100,
          name: "Posted deposit",
          pending: false,
        })
        .select("id, provider_pending_transaction_id")
        .single();

      expect(postedTxn?.provider_pending_transaction_id).toBe(pendingId);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("requires positive matched_amount and same-org bank match rows", async () => {
    const supabase = createIntegrationClient();
    const orgA = await createTestOrganization(supabase, "p5-match-a");
    const orgB = await createTestOrganization(supabase, "p5-match-b");

    try {
      const { data: connection } = await supabase
        .from("teller_bank_connections")
        .insert({
          organization_id: orgA.organizationId,
          provider: "manual_csv",
          external_item_id: `match-${Date.now()}`,
        })
        .select("id")
        .single();

      const { data: bankAccount } = await supabase
        .from("teller_bank_accounts")
        .insert({
          organization_id: orgA.organizationId,
          connection_id: connection!.id,
          external_account_id: `match-acct-${Date.now()}`,
          name: "Checking",
          gl_account_id: orgA.accountIds["1000"],
        })
        .select("id")
        .single();

      const { data: txn } = await supabase
        .from("teller_bank_transactions")
        .insert({
          organization_id: orgA.organizationId,
          bank_account_id: bankAccount!.id,
          external_transaction_id: `match-txn-${Date.now()}`,
          posted_date: "2026-05-04",
          amount: 50,
          name: "Vendor payment",
        })
        .select("id, normalized_amount")
        .single();

      const badAmount = await supabase.from("teller_bank_matches").insert({
        organization_id: orgA.organizationId,
        bank_transaction_id: txn!.id,
        matched_resource_type: "journal_entry",
        matched_resource_id: orgA.accountIds["1000"],
        matched_amount: -50,
        status: "confirmed",
      });
      expect(badAmount.error).toBeTruthy();

      const crossOrg = await supabase.from("teller_bank_matches").insert({
        organization_id: orgB.organizationId,
        bank_transaction_id: txn!.id,
        matched_resource_type: "journal_entry",
        matched_resource_id: orgB.accountIds["1000"],
        matched_amount: 50,
        status: "confirmed",
      });
      expect(crossOrg.error).toBeTruthy();
      expect(crossOrg.error!.message.toLowerCase()).toMatch(/organization|mismatch/);

      const good = await supabase.from("teller_bank_matches").insert({
        organization_id: orgA.organizationId,
        bank_transaction_id: txn!.id,
        matched_resource_type: "journal_entry",
        matched_resource_id: orgA.accountIds["1000"],
        matched_amount: 50,
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
      });
      expect(good.error).toBeNull();
    } finally {
      await deleteTestOrganization(supabase, orgA.organizationId);
      await deleteTestOrganization(supabase, orgB.organizationId);
    }
  });

  it("rejects reconciliation items from another organization", async () => {
    const supabase = createIntegrationClient();
    const orgA = await createTestOrganization(supabase, "p5-recon-a");
    const orgB = await createTestOrganization(supabase, "p5-recon-b");

    try {
      const { data: connection } = await supabase
        .from("teller_bank_connections")
        .insert({
          organization_id: orgA.organizationId,
          provider: "manual_csv",
          external_item_id: `recon-${Date.now()}`,
        })
        .select("id")
        .single();

      const { data: bankAccount } = await supabase
        .from("teller_bank_accounts")
        .insert({
          organization_id: orgA.organizationId,
          connection_id: connection!.id,
          external_account_id: `recon-acct-${Date.now()}`,
          name: "Checking",
          gl_account_id: orgA.accountIds["1000"],
        })
        .select("id")
        .single();

      const { data: reconciliation } = await supabase
        .from("teller_bank_reconciliations")
        .insert({
          organization_id: orgA.organizationId,
          bank_account_id: bankAccount!.id,
          statement_start_date: "2026-05-01",
          statement_end_date: "2026-05-31",
          beginning_reconciled_balance: 0,
          statement_ending_balance: 1000,
          status: "draft",
        })
        .select("id")
        .single();

      const { data: txn } = await supabase
        .from("teller_bank_transactions")
        .insert({
          organization_id: orgA.organizationId,
          bank_account_id: bankAccount!.id,
          external_transaction_id: `recon-txn-${Date.now()}`,
          posted_date: "2026-05-10",
          amount: -100,
          name: "Deposit",
        })
        .select("id")
        .single();

      const crossOrgItem = await supabase.from("teller_bank_reconciliation_items").insert({
        organization_id: orgB.organizationId,
        reconciliation_id: reconciliation!.id,
        bank_transaction_id: txn!.id,
        cleared_amount: 100,
        cleared_date: "2026-05-15",
      });
      expect(crossOrgItem.error).toBeTruthy();
      expect(crossOrgItem.error!.message.toLowerCase()).toMatch(/organization|mismatch/);
    } finally {
      await deleteTestOrganization(supabase, orgA.organizationId);
      await deleteTestOrganization(supabase, orgB.organizationId);
    }
  });

  it("keeps legacy match_status readable alongside authoritative status", async () => {
    const supabase = createIntegrationClient();
    const { organizationId, accountIds } = await createTestOrganization(supabase, "p5-legacy");

    try {
      const { data: connection } = await supabase
        .from("teller_bank_connections")
        .insert({
          organization_id: organizationId,
          provider: "manual_csv",
          external_item_id: `legacy-${Date.now()}`,
        })
        .select("id")
        .single();

      const { data: bankAccount } = await supabase
        .from("teller_bank_accounts")
        .insert({
          organization_id: organizationId,
          connection_id: connection!.id,
          external_account_id: `legacy-acct-${Date.now()}`,
          name: "Checking",
          gl_account_id: accountIds["1000"],
        })
        .select("id")
        .single();

      const { data: txn, error } = await supabase
        .from("teller_bank_transactions")
        .insert({
          organization_id: organizationId,
          bank_account_id: bankAccount!.id,
          external_transaction_id: `legacy-txn-${Date.now()}`,
          posted_date: "2026-05-05",
          amount: -25,
          name: "Bank fee",
          match_status: "unmatched",
        })
        .select("status, match_status, normalized_amount")
        .single();

      expect(error).toBeNull();
      expect(txn?.status).toBe("unreviewed");
      expect(txn?.match_status).toBe("unmatched");
      expect(Number(txn?.normalized_amount)).toBe(25);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });
});
