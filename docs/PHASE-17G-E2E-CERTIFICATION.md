# Phase 17G — Full End-to-End Accounting Lifecycle Certification

**Status:** Release certification phase (not feature development)  
**Feature freeze:** Active — do not begin Phase 17H from this slice  
**Production patches verified:** 051 (security), 052 (reliability), 053 (performance), 054 (operations)

## Certification gates

```
E2E_LIFECYCLE_MATRIX = COMPLETE
HFAC_USED_AS_E2E_FIXTURE = false
E2E_FIXTURE_RESET = PASS
```

| Gate | Value |
|------|-------|
| `E2E_LIFECYCLE_MATRIX` | COMPLETE |
| `HFAC_USED_AS_E2E_FIXTURE` | false |
| `E2E_FIXTURE_RESET` | PASS (via `resetDemoBooksOpen` in phase demo runners) |
| `PRODUCTION_E2E_MUTATION_BY_TEST` | false |
| `NEW_SQL_PATCH_REQUIRED` | false (no 055 unless verified DB defect) |

## Dedicated fixtures (never HFAC)

| Fixture | Env var | Purpose |
|---------|---------|---------|
| Multi-entity demo | `TELLER_PHASE16_DEMO_ORG_ID` | IC, consolidation, entity switching |
| Phase 5 banking | `TELLER_PHASE5_DEMO_ORG_ID` | Bank ingest, match, transfer, recon |
| Phase 6 AP | `TELLER_PHASE6_DEMO_ORG_ID` | Vendor/bill/payment lifecycle |
| Phase 7 jobs | `TELLER_PHASE7_DEMO_ORG_ID` | Job costing |
| Phase 8 assets | `TELLER_PHASE8_DEMO_ORG_ID` | Fixed asset lifecycle |
| Phase 9 close | `TELLER_PHASE9_DEMO_ORG_ID` | Month-end close |
| Phase 11 recurring | `TELLER_PHASE11_DEMO_ORG_ID` | Recurring journals |
| Phase 12 payroll | `TELLER_PHASE12_DEMO_ORG_ID` | Payroll accounting import |
| Phase 13 inventory | `TELLER_PHASE13_DEMO_ORG_ID` | GRNI, consume-before-bill |
| Phase 14 planning | `TELLER_PHASE14_DEMO_ORG_ID` | Planning vs GL separation |
| Phase 15 tax | `TELLER_PHASE15_DEMO_ORG_ID` | MO/KS sales tax |
| HFAC integration | `TELLER_HFAC_ORG_ID` | **Read-only baseline only — 8 docs, 17 journals** |

Reset: each controlled demo runner calls `resetDemoBooksOpen()` at start — deterministic, no manual cleanup, accounting rules unchanged.

## Master lifecycle matrix

Columns: **WORKFLOW · STARTING STATE · USER ACTION · DOCUMENT · SUBLEDGER · JOURNAL · GL · REPORTS · REVERSAL · AUDIT · ENTITY · EXPECTED · TEST ID · STATUS**

### Accounts Receivable (§4–8, §33, §35–37)

| WORKFLOW | STARTING STATE | USER ACTION | DOCUMENT | SUBLEDGER | JOURNAL | GL | REPORTS | REVERSAL | AUDIT | ENTITY | EXPECTED | TEST ID | STATUS |
|----------|----------------|-------------|----------|-----------|---------|-----|---------|----------|-------|--------|----------|---------|--------|
| Create customer | Empty party list | Add customer | Party | — | — | — | — | — | party.created | Single entity | Customer visible | 17G-AR-01 | PASS |
| Create invoice | Customer exists | Draft + post invoice | Invoice posted | AR +$ | Dr AR Cr Rev | AR↑ Rev↑ | P&L revenue | Void/reverse | invoice.posted | Entity default | Status posted, balance = total | 17G-AR-02 | PASS |
| Partial payment | Invoice open | Record payment 40% | Payment partial | AR −$ | Dr Cash Cr AR | Cash↑ AR↓ | AR aging | Reverse payment | payment.recorded | Same entity | Remaining = 60% | 17G-AR-03 | PASS |
| Second payment | Partially paid | Record payment 30% | Payment | AR −$ | Dr Cash Cr AR | Cash↑ AR↓ | AR aging | Reverse | payment.recorded | Same | Remaining = 30% | 17G-AR-04 | PASS |
| Full payment | Open balance | Final payment | Payment | AR = 0 | Dr Cash Cr AR | AR cleared | Collected metric | Reverse | payment.recorded | Same | Status paid | 17G-AR-05 | PASS |
| Credit memo | Invoice history | Issue credit | Credit memo | AR −$ (net) | Dr Rev Cr AR | AR↓ | P&L | Reverse credit | credit.issued | Same | Unapplied credit balance | 17G-CR-01 | PASS |
| Apply credit | Credit unapplied | Apply to invoice | Allocation | AR net ↓ | Dr AR offset | AR↓ | Aging | Reverse apply | credit.applied | Same | Invoice remaining reduced | 17G-CR-02 | PASS |
| Customer deposit | — | Receive deposit | Deposit payment | Deposit liability +$ | Dr Cash Cr Dep Liab | **No revenue** | BS liability | Reverse receipt | deposit.received | Same | Unapplied deposit | 17G-DEP-01 | PASS |
| Apply deposit | Deposit + invoice | Apply partial/full | Application | AR↓ Liab↓ | Dr Liab Cr AR | AR reduction | Aging | Reverse apply | deposit.applied | Same | Net AR correct | 17G-DEP-02 | PASS |
| Refund | Deposit/credit balance | Issue refund | Refund | Cash↓ liability↓ | Dr Liab Cr Cash | Cash↓ | CF | Reverse | refund.recorded | Same | Balanced refund | 17G-RF-01 | PASS |
| Write-off | Uncollectible AR | Bad debt write-off | Write-off | AR ↓ | Dr Bad Debt Cr AR | Expense↑ | P&L | Reverse | writeoff.posted | Same | AR cleared | 17G-WO-01 | PASS |
| AR aging buckets | Multiple dates | — | Invoices | Remaining authoritative | — | — | Aging report | — | — | Same | 30/60/90+ buckets | 17G-AR-AGE | PASS |
| Over-allocation guard | Open invoice $600 | Pay $700 | Rejected | — | — | — | — | — | — | Same | Error, no post | 17G-AR-OVER | PASS |

**Deposit semantics (certified):** `DEPOSIT_RECEIPT_RECOGNIZES_REVENUE = false` · `DEPOSIT_APPLICATION_RECOGNIZES_AR_REDUCTION = true`

Demo coverage: Phase 3 unit tests, Phase 5/6 demos, `src/lib/e2e/phase17g-ar.test.ts`

### Accounts Payable (§9–10, §34, §35–37)

| WORKFLOW | STARTING STATE | USER ACTION | DOCUMENT | SUBLEDGER | JOURNAL | GL | REPORTS | REVERSAL | AUDIT | ENTITY | EXPECTED | TEST ID | STATUS |
|----------|----------------|-------------|----------|-----------|---------|-----|---------|----------|-------|--------|----------|---------|--------|
| Create vendor | — | Add vendor | Party | — | — | — | — | — | party.created | Entity | Vendor visible | 17G-AP-01 | PASS |
| Create/post bill | Vendor exists | Post bill | Bill posted | AP +$ | Dr Exp Cr AP | AP↑ Exp↑ | P&L | Void | bill.posted | Entity | Open AP | 17G-AP-02 | PASS |
| Partial AP payment | Bill open | Pay 50% | Payment | AP −$ | Dr AP Cr Cash | AP↓ Cash↓ | AP aging | Reverse | payment.recorded | Same | Remaining 50% | 17G-AP-03 | PASS |
| Multi-payment AP | Bill open | 2 payments | Payments | AP → 0 | Dr AP Cr Cash | AP cleared | AP aging | Reverse | payment.recorded | Same | Paid status | 17G-AP-04 | PASS |
| Vendor credit | Bill history | Issue credit | Vendor credit | AP net ↓ | Dr AP Cr Exp | AP↓ | P&L | Reverse | credit.issued | Same | Unapplied credit | 17G-AP-CR | PASS |
| Apply vendor credit | Credit open | Apply to bill | Allocation | AP ↓ | Offset | AP↓ | AP aging | Reverse | credit.applied | Same | Bill reduced | 17G-AP-CR2 | PASS |
| Purchase order | PO enabled | Create→approve→receive | PO | — | — | — | — | Close PO | po.* | Entity | PO lifecycle | 17G-PO-01 | PASS |
| PO to bill match | PO received | Match bill | Bill | AP | Dr GRNI/Exp Cr AP | AP↑ | AP aging | Reverse | bill.posted | Same | Matched qty/amount | 17G-PO-02 | PASS |

Demo coverage: Phase 6 demo, `accept:phase6:controlled`, `src/lib/e2e/phase17g-ap.test.ts`

### Inventory / GRNI (§11–14)

| WORKFLOW | STARTING STATE | USER ACTION | DOCUMENT | SUBLEDGER | JOURNAL | GL | REPORTS | REVERSAL | AUDIT | ENTITY | EXPECTED | TEST ID | STATUS |
|----------|----------------|-------------|----------|-----------|---------|-----|---------|----------|-------|--------|----------|---------|--------|
| Receive before bill | PO open | Receive inventory | Receipt | On-hand↑ GRNI↑ | Dr Inv Cr GRNI | Inv↑ GRNI↑ | BS | Reverse receipt | inventory.received | Entity | GRNI open | 17G-GRNI-01 | PASS |
| Bill after receipt | GRNI open | Post vendor bill | Bill | GRNI cleared | Dr GRNI Cr AP | GRNI↓ AP↑ | BS/AP | Reverse | bill.posted | Same | **No double inventory debit** | 17G-GRNI-02 | PASS |
| Consume before bill | Received stock | Issue to job | Consumption | On-hand↓ | Dr COGS Cr Inv | Inv↓ | Job P&L | Reverse | inventory.consumed | Same | On-hand reduced | 17G-CONSUME-01 | PASS |
| Bill after consume | GRNI + consumed | Post bill | Bill | GRNI cleared | Dr GRNI Cr AP | GRNI↓ | — | Reverse | bill.posted | Same | GRNI cleared without 2nd Inv debit | 17G-CONSUME-02 | PASS |
| Inventory adjustment | On-hand known | +/- adjustment | Adjustment | On-hand | Dr/Cr Inv | Inv | BS | Reverse | inventory.adjusted | Same | Quantity/value correct | 17G-INV-ADJ | PASS |

**Certified:** `INVENTORY_DOUBLE_DEBIT = false` · `GRNI_RECONCILES_TO_OPEN_RECEIPTS = true`

Demo coverage: Phase 13 demo (`demo:phase13:controlled`, 178 scenarios)

### Banking (§15–18, §55)

| WORKFLOW | STARTING STATE | USER ACTION | DOCUMENT | SUBLEDGER | JOURNAL | GL | REPORTS | REVERSAL | AUDIT | ENTITY | EXPECTED | TEST ID | STATUS |
|----------|----------------|-------------|----------|-----------|---------|-----|---------|----------|-------|--------|----------|---------|--------|
| Bank ingest | Connected account | Import transactions | Bank txn pending | — | — | — | Banking | — | bank.imported | Bank entity | Pending review | 17G-BNK-01 | PASS |
| Categorize | Pending txn | Categorize expense | Bank txn posted | — | Dr Exp Cr Cash | Exp↑ | P&L | Uncategorize | bank.categorized | Same entity | Journal linked | 17G-BNK-02 | PASS |
| Match payment | Open payment | Match bank line | Matched | — | **No duplicate GL** | — | Banking | Unmatch | bank.matched | Same | Single economic post | 17G-BNK-03 | PASS |
| Transfer | Two bank accounts | Transfer funds | Transfer | — | Dr Cash-B Cr Cash-A | Cash net 0 | CF | Reverse | bank.transfer | Same entity | Balanced | 17G-BNK-04 | PASS |
| Reconciliation | Statement period | Match + finalize | Recon session | — | — | — | — | Reopen | bank.reconciled | Same | Ending = statement | 17G-BNK-05 | PASS |
| Cross-entity bank | Entity A account | Use on Entity B txn | Rejected | — | — | — | — | — | — | — | Error | 17G-BNK-XE | PASS |

**Certified:** `BANK_MATCH_DUPLICATE_POSTING = false` · `BANK_ACCOUNT_SINGLE_ENTITY = true`

Demo coverage: Phase 5 demo, `src/lib/e2e/phase17g-banking.test.ts`

### Core accounting (§19–29)

| WORKFLOW | STARTING STATE | USER ACTION | DOCUMENT | SUBLEDGER | JOURNAL | GL | REPORTS | REVERSAL | AUDIT | ENTITY | EXPECTED | TEST ID | STATUS |
|----------|----------------|-------------|----------|-----------|---------|-----|---------|----------|-------|--------|----------|---------|--------|
| Manual expense | — | Enter expense | Expense | — | Dr Exp Cr Cash/AP | Exp↑ | P&L | Void | expense.posted | Entity | Posted | 17G-EXP-01 | PASS |
| Job costing | Job open | Rev + labor + materials | Job docs | Job P&L | Various | GL consistent | Job report | Reverse | job.* | Org-scoped | Margin correct | 17G-JOB-01 | PASS |
| Fixed asset | — | Acquire + capitalize | Asset | Asset register | Dr FA Cr Cash/AP | FA↑ | BS | Dispose | asset.* | Entity | Dep schedule | 17G-FA-01 | PASS |
| Depreciation | Asset active | Run depreciation | Schedule occ | Acc dep↑ | Dr Dep Exp Cr Acc Dep | Exp↑ | P&L/BS | Reverse | depreciation.posted | Entity | Multi-period | 17G-FA-02 | PASS |
| Payroll accounting | Import file | Post payroll run | Payroll run | Liabilities | Dr Exp Cr Pay/Cash | Exp/Liab | P&L/BS | Reverse | payroll.posted | Entity | **Import/post only — not payroll processing** | 17G-PAY-01 | PASS |
| Sales tax MO/KS | Taxable invoice | Post with tax | Invoice | Tax liability | Dr AR Cr Rev+Tax | Liab↑ | Tax report | Reverse | tax.posted | Entity | MO/KS packs | 17G-TAX-01 | PASS |
| Recurring journal | Template | Generate + post | Occurrence | — | Template lines | GL | TB | Reverse | recurring.posted | Entity | No duplicate occ | 17G-REC-01 | PASS |
| Accrual | Open period | Accrue + reverse + settle | Accrual | — | Dr Exp Cr Accrued | Liab↑ | P&L | Reverse/settle | accrual.* | Entity | Settles to bill | 17G-ACC-01 | PASS |
| Manual journal | Open period | Balanced entry | Journal | — | User lines | GL | TB/Ledger | Reverse | journal.posted | Entity | Posted | 17G-MJ-01 | PASS |
| Unbalanced journal | — | Dr≠Cr entry | Rejected | — | — | — | — | — | — | Entity | **Rejected** | 17G-MJ-02 | PASS |
| Adjusting entry | Pre-close | Adjust | Journal | — | Adjusting | GL | TB | Reverse | journal.posted | Entity | Posted | 17G-ADJ-01 | PASS |
| Month-end close | Review done | Close period | Period closed | — | — | — | — | Reopen auth | period.closed | Entity A | **No post to closed** | 17G-CLOSE-01 | PASS |
| State conflict | Stale UI | Post after change | Error | — | — | — | — | — | — | Entity | Recoverable error | 17G-STATE-01 | PASS |

Demo coverage: Phases 7–12, 15, 9 demos + unit tests

### Financial statements & controls (§30–32, §73–82)

| WORKFLOW | STARTING STATE | USER ACTION | DOCUMENT | SUBLEDGER | JOURNAL | GL | REPORTS | REVERSAL | AUDIT | ENTITY | EXPECTED | TEST ID | STATUS |
|----------|----------------|-------------|----------|-----------|---------|-----|---------|----------|-------|--------|----------|---------|--------|
| Trial balance | Posted activity | Run TB | — | — | — | Debits=Credits | TB | — | — | Entity/All Co | Balanced | 17G-TB | PASS |
| P&L | Posted activity | Run P&L | — | — | — | Rev−Exp | P&L | — | — | Entity | Matches GL | 17G-PL | PASS |
| Balance sheet | Posted activity | Run BS | — | — | A=L+E | BS | — | — | Entity | Equation holds | 17G-BS | PASS |
| Cash flow | Posted activity | Run CF | — | — | — | CF | Ending=cash | — | Entity | Reconciles | 17G-CF | PASS |
| Retained earnings | Multi-period | Compare RE | — | — | — | RE rollforward | BS | — | — | Entity | Current+RE | 17G-RE | PASS |
| AR control recon | Subledger+GL | Compare | — | AR control | — | AR account | AR report | — | — | Entity | Match | 17G-AR-CTL | PASS |
| AP control recon | Subledger+GL | Compare | — | AP control | — | AP account | AP report | — | — | Entity | Match | 17G-AP-CTL | PASS |
| Deposit control | Payments | Compare | — | Deposit liab | — | BS liab | — | — | Entity | Match | 17G-DEP-CTL | PASS |
| Doc-journal trace | Posted docs | Link check | Documents | — | Linked JE | — | — | — | Entity | Every post has JE | 17G-DOC-JE | PASS |
| Accounting checksum | Fixture end state | Sum controls | — | All controls | — | GL | Cross-check | — | — | Demo org | Expected=actual | 17G-CHK | PASS |

### Multi-entity & consolidation (§40–42, §46–54, §56)

| WORKFLOW | STARTING STATE | USER ACTION | DOCUMENT | SUBLEDGER | JOURNAL | GL | REPORTS | REVERSAL | AUDIT | ENTITY | EXPECTED | TEST ID | STATUS |
|----------|----------------|-------------|----------|-----------|---------|-----|---------|----------|-------|--------|----------|---------|--------|
| Entity switch | Multi-entity org | Switch A↔B | — | Scoped | Per entity | Per entity | Per entity | — | — | A or B | Independent books | 17G-ENT-SW | PASS |
| One journal one entity | — | Post | Journal | — | Single entity_id | — | — | — | journal.posted | One | **Enforced** | 17G-OJOE | PASS |
| All Companies report | Multi-entity | View consolidated | — | — | — | Combined | Consolidated | — | — | All (read) | Report only | 17G-ALL-R | PASS |
| All Companies post | All Companies ctx | Attempt post | Rejected | — | — | — | — | — | — | — | **Cannot post** | 17G-ALL-P | PASS |
| IC posting | Two entities | IC transaction | IC pair | Due from/to | Paired JEs | IC balances | IC recon | Reverse pair | ic.posted | A+B atomic | **No partial** | 17G-IC-01 | PASS |
| IC settlement | Open IC items | Partial/full pay | Settlement | IC ↓ | Dr/Cr IC + Cash | IC cleared | IC recon | Reverse | ic.settled | Entities | No oversettle | 17G-IC-02 | PASS |
| Consolidation | Entity reports | Pre-elim TB/P&L/BS | — | — | — | Sum entities | Consolidated | — | — | Group | Pre-elim correct | 17G-CON-01 | PASS |
| Elimination | IC balances | Post elimination | Worksheet | — | Elim JE | Group only | Post-elim | Reverse | elim.posted | **Entity books unchanged** | 17G-ELIM-01 | PASS |
| Entity period isolation | A closed | Post to B | B open | — | — | — | — | — | period.closed | A closed B open | B unaffected | 17G-ENT-ISO | PASS |
| Cross-org negative | Org A session | Org B resource ID | Rejected | — | — | — | — | — | — | — | **No leak** | 17G-XORG | PASS |
| Cross-entity negative | Restricted user | Other entity doc | Rejected | — | — | — | — | — | — | — | **No leak** | 17G-XENT | PASS |

Demo coverage: Phase 16 demos (`accept:phase16j:controlled`), `src/lib/e2e/phase17g-multientity.test.ts`

### Reliability, security, UX (§38–45, §58–71)

| WORKFLOW | STARTING STATE | USER ACTION | DOCUMENT | SUBLEDGER | JOURNAL | GL | REPORTS | REVERSAL | AUDIT | ENTITY | EXPECTED | TEST ID | STATUS |
|----------|----------------|-------------|----------|-----------|---------|-----|---------|----------|-------|--------|----------|---------|--------|
| Payment retry | — | Duplicate submit | Idempotent | — | Single JE | — | — | — | — | Entity | Same result | 17G-RETRY-PAY | PASS |
| Deposit retry | — | Duplicate receipt | Idempotent | — | Single JE | — | — | — | — | Entity | Same result | 17G-RETRY-DEP | PASS |
| Bank retry | — | Duplicate categorize | Idempotent | — | Single JE | — | — | — | — | Entity | Same result | 17G-RETRY-BNK | PASS |
| Recurring retry | — | Rerun occurrence | Idempotent | — | Single JE | — | — | — | — | Entity | No duplicate | 17G-RETRY-REC | PASS |
| HFAC replay | Webhook | Duplicate event | Idempotent | — | Single JE | — | — | — | hfac.* | Mapped org | No dup post | 17G-HFAC-01 | PASS |
| HFAC invalid sig | — | Bad signature | Rejected | — | — | — | — | — | — | — | 401 | 17G-HFAC-SEC | PASS |
| Owner mode | Owner role | Invoice workflow | Same docs | Same | Same | Same | Simpler labels | Same | Same | Entity | **Accounting unchanged** | 17G-UX-OWN | PASS |
| Accountant mode | Bookkeeper | Full workflow | Same | Same | Same | Same | Technical labels | Same | Same | Entity | Full nav | 17G-UX-ACC | PASS |
| Mode switch | Mid-session | Toggle mode | — | — | — | — | Nav changes | — | — | — | **No accounting change** | 17G-UX-SW | PASS |
| Audit traceability | Major flows | — | — | — | — | — | — | — | audit.append | — | Events recorded | 17G-AUD-01 | PASS |
| Audit immutability | Normal user | Update/delete audit | Rejected | — | — | — | — | — | — | — | **Rejected** (054) | 17G-AUD-02 | PASS |
| Patch 051–054 | Production | Probe RPCs | — | — | — | — | — | — | — | — | All true | 17G-P051–054 | PASS |

### Production & release (§63–71, §92–93)

| Check | TEST ID | STATUS |
|-------|---------|--------|
| Production routes smoke | 17G-RT-SMOKE | PASS |
| Production build | 17G-BUILD | PASS |
| Phase 17A–F regression | 17G-REG-17 | PASS |
| Historical demo regression (`test:full`) | 17G-HIST | PASS |
| E2E performance regression guard | 17G-PERF | PASS |
| No silent critical failures | 17G-SILENT | PASS |
| No placeholder E2E tests | 17G-PLACEHOLDER | PASS |

## Findings log

| ID | Severity | Workflow | Failure | Accounting impact | User impact | Root cause | Fix | Regression test | Status |
|----|----------|----------|---------|-------------------|-------------|------------|-----|-----------------|--------|
| 17G-001 | INFO | Production ops routes | `/api/ready` returns 404 on current production deploy | None — DB patches 051–054 effective | Ops readiness probe unavailable until redeploy | 17E route not yet in deployed build | Redeploy application to production | `verify-phase17g-production.mjs` static + live split | OPEN (non-blocking) |
| 17G-002 | INFO | Demo fixture debt | 5 orphan demo payment rows on Phase 16 demo org | None on production | None | Historical demo fixture (documented 17A-014) | No change in 17G — fixture debt only | `financial_integrity_critical` filter | DOCUMENTED |

## Launch blocker classification

`PHASE17G_LAUNCH_BLOCKERS = []`

## Operator carry-forward (17E → 17H)

Confirm production backup/PITR retention in Supabase Dashboard → Database → Backups. Not 17G coding work.

## Run commands

```bash
# Controlled E2E certification (runs twice)
TELLER_CONTROLLED_PROD_TEST=1 npm run accept:phase17g:controlled

# Production read-only verify
TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase17g:production

# Unit E2E tests
npx vitest run src/lib/e2e/

# Full release gate
npm run test:fast
TELLER_TEST_PHASE=17 npm run test:phase
npm run test:full
npm run build
```
