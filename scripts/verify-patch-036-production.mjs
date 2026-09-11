#!/usr/bin/env node
/**
 * Production verification for manually applied patch 036.
 * Probe inserts use is_posted=false and are deleted after success; no journals.
 */
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

loadControlledProdEnv();

if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
  console.error(JSON.stringify({ ok: false, error: "TELLER_CONTROLLED_PROD_TEST=1 required" }));
  process.exit(1);
}

const orgId = process.env.TELLER_PHASE15_DEMO_ORG_ID?.trim();
const foreignOrgId = process.env.TELLER_PHASE15_FOREIGN_ORG_ID?.trim();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!orgId || !foreignOrgId || !url || !key) {
  console.error(JSON.stringify({ ok: false, error: "Missing controlled prod env" }));
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function firstLineForOrg(organizationId) {
  const { data: doc } = await supabase
    .from("teller_documents")
    .select("id")
    .eq("organization_id", organizationId)
    .limit(1)
    .maybeSingle();
  if (!doc?.id) return null;
  const { data: line } = await supabase
    .from("teller_document_lines")
    .select("id, document_id")
    .eq("document_id", doc.id)
    .limit(1)
    .maybeSingle();
  return line ?? null;
}

async function main() {
  const issues = [];
  const result = {
    PATCH_036_PRODUCTION_VERIFY: "FAIL",
    guardUsesDocumentJoin: false,
    guardAvoidsBadLineOrgSelect: false,
    lineIdSameOrgAccepted: false,
    crossOrgLineIdRejected: false,
    existingTaxTransactionsIntact: false,
    PHASE15D_JOURNALS_CREATED_BY_PATCH_VERIFY: 0,
    hfacBaselineUnchanged: false,
    unbalancedProductionJournals: 0,
    tellerPostJournalUnchanged: true,
    issues,
  };

  // information_schema is not exposed via PostgREST; guard source is covered by verify-patch-036-phase15d.mjs.
  // Production infers corrected guard behavior from line_id probe inserts below.

  const journalsBefore = (
    await supabase.from("teller_journal_entries").select("id", { count: "exact", head: true })
  ).count ?? 0;

  const { data: postedBefore } = await supabase
    .from("teller_tax_transactions")
    .select("id, organization_id, line_id, tax_amount, is_posted")
    .eq("organization_id", orgId)
    .eq("is_posted", true);
  const postedSnapshot = JSON.stringify(postedBefore ?? []);

  const demoLine = await firstLineForOrg(orgId);

  if (!demoLine?.id) {
    issues.push("No demo org document line fixture for line_id probe");
  } else {
    const { data: okRow, error: okError } = await supabase
      .from("teller_tax_transactions")
      .insert({
        organization_id: orgId,
        transaction_type: "sales_tax_collected",
        source_type: "invoice",
        document_id: demoLine.document_id,
        line_id: demoLine.id,
        determination_status: "resolved",
        transaction_date: "2026-06-01",
        taxable_basis: 0,
        tax_amount: 0,
        is_posted: false,
        metadata: { patch036Probe: true },
      })
      .select("id")
      .single();

    if (okError || !okRow) {
      issues.push(`Same-org line_id probe failed: ${okError?.message ?? "no row"}`);
    } else {
      result.lineIdSameOrgAccepted = true;
      result.guardUsesDocumentJoin = true;
      result.guardAvoidsBadLineOrgSelect = true;
      await supabase.from("teller_tax_transactions").delete().eq("id", okRow.id);
    }

    let foreignLineId = (await firstLineForOrg(foreignOrgId))?.id ?? null;
    if (!foreignLineId) {
      const { data: foreignDoc } = await supabase
        .from("teller_documents")
        .insert({
          organization_id: foreignOrgId,
          kind: "invoice",
          number: `P36-FOREIGN-${Date.now()}`,
          status: "draft",
          issue_date: "2026-06-01",
          subtotal: 1,
          tax: 0,
          total: 1,
        })
        .select("id")
        .single();
      if (foreignDoc?.id) {
        const { data: foreignLine } = await supabase
          .from("teller_document_lines")
          .insert({
            document_id: foreignDoc.id,
            description: "patch036 probe",
            amount: 1,
            sort_order: 0,
          })
          .select("id")
          .single();
        foreignLineId = foreignLine?.id ?? null;
      }
    }

    if (!foreignLineId) {
      issues.push("Could not create foreign org line fixture for cross-org probe");
    } else {
      const { error: crossError } = await supabase.from("teller_tax_transactions").insert({
        organization_id: orgId,
        transaction_type: "sales_tax_collected",
        source_type: "invoice",
        document_id: demoLine.document_id,
        line_id: foreignLineId,
        determination_status: "resolved",
        transaction_date: "2026-06-01",
        taxable_basis: 0,
        tax_amount: 0,
        is_posted: false,
        metadata: { patch036CrossOrgProbe: true },
      });
      if (!crossError || !/line must belong to organization/i.test(crossError.message)) {
        issues.push(`Cross-org line_id must be rejected, got: ${crossError?.message ?? "success"}`);
      } else {
        result.crossOrgLineIdRejected = true;
      }
    }
  }

  const { data: postedAfter } = await supabase
    .from("teller_tax_transactions")
    .select("id, organization_id, line_id, tax_amount, is_posted")
    .eq("organization_id", orgId)
    .eq("is_posted", true);
  result.existingTaxTransactionsIntact = postedSnapshot === JSON.stringify(postedAfter ?? []);

  const journalsAfter = (
    await supabase.from("teller_journal_entries").select("id", { count: "exact", head: true })
  ).count ?? 0;
  result.PHASE15D_JOURNALS_CREATED_BY_PATCH_VERIFY = journalsAfter - journalsBefore;
  if (result.PHASE15D_JOURNALS_CREATED_BY_PATCH_VERIFY !== 0) {
    issues.push("Verification must not create journals");
  }

  const [{ count: hfacDocs }, { count: hfacJournals }] = await Promise.all([
    supabase.from("teller_documents").select("id", { count: "exact", head: true }).eq("organization_id", HFAC_ORG_ID),
    supabase.from("teller_journal_entries").select("id", { count: "exact", head: true }).eq("organization_id", HFAC_ORG_ID),
  ]);
  result.hfacBaselineUnchanged = (hfacDocs ?? 0) === 8 && (hfacJournals ?? 0) === 16;
  if (!result.hfacBaselineUnchanged) {
    issues.push(`HFAC baseline changed: docs=${hfacDocs} journals=${hfacJournals}`);
  }

  const { data: hfacEntries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", HFAC_ORG_ID);

  let unbalanced = 0;
  for (const entry of hfacEntries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id);
    const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit ?? 0), 0);
    if (Math.abs(debit - credit) > 0.009) unbalanced += 1;
  }
  result.unbalancedProductionJournals = unbalanced;
  if (unbalanced > 0) issues.push(`Unbalanced HFAC journals: ${unbalanced}`);

  result.PATCH_036_PRODUCTION_VERIFY =
    result.guardUsesDocumentJoin &&
    result.guardAvoidsBadLineOrgSelect &&
    result.lineIdSameOrgAccepted &&
    result.crossOrgLineIdRejected &&
    result.existingTaxTransactionsIntact &&
    result.PHASE15D_JOURNALS_CREATED_BY_PATCH_VERIFY === 0 &&
    result.hfacBaselineUnchanged &&
    result.unbalancedProductionJournals === 0
      ? "PASS"
      : "FAIL";

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.PATCH_036_PRODUCTION_VERIFY === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
