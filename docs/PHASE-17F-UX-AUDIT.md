# Phase 17F — Owner / Accountant UX Simplification

**Status:** Complete · **No DB patch required**

---

## 1. User modes

**OWNER_MODE = DEFINED** — plain language, money in/out, action-first  
**ACCOUNTANT_MODE = DEFINED** — GL terminology, workspace, schedules, close  
**ACCOUNTING_ENGINE_SHARED = true** — same data, different presentation

**MODE_SWITCHING_MODEL = Cookie preference (`teller_presentation_mode`) + sidebar toggle**

- Default: `owner` for owner/viewer roles; `accountant` for admin/bookkeeper  
- Optional org default via `teller_industry_settings.answers.defaultPresentationMode`  
- URL `?mode=owner` still overrides on reports  
- No database migration required

---

## 2. Navigation model

**NAVIGATION_MODEL = COMPLETE** (`src/lib/ux/navigation.ts`)

| Owner primary | Accountant additional |
|---------------|----------------------|
| Dashboard | AP dashboard |
| Money in (Invoices) | Chart of accounts |
| Customers | General ledger |
| Money out (Bills) | Accountant workspace |
| Banking | Accounting hub |
| Jobs | Schedules |
| Reports | Month-end close |
| Settings | All companies, Planning |

---

## 3. Screen audit (summary)

| Screen | Primary user | Issue (pre-17F) | 17F change | Severity |
|--------|--------------|-----------------|------------|----------|
| Dashboard | Owner | Collected used cache | Subledger remaining | HIGH |
| Invoices | Owner | No remaining column | Remaining + empty state | HIGH |
| Reports AR aging | Accountant | Full invoice totals | Authoritative remaining | HIGH |
| All Companies | Both | Posting context unclear | View-only alert | MEDIUM |
| Jobs | Owner | No entity banner | Context header + note | MEDIUM |
| Sidebar | Both | 20+ flat links | Mode-filtered nav | MEDIUM |
| Bills | Owner | Good remaining column | Unchanged (model) | — |
| Banking | Both | OK workflow | Deferred labels | LOW |

**UX_AUDIT = COMPLETE**

---

## 4. Terminology

**OWNER_TERMINOLOGY_MAP = COMPLETE** (`src/lib/accounting/presentation-mode.ts` + nav labels)  
**ACCOUNTANT_TERMINOLOGY_PRESERVED = true**

Key mappings: AR → Customers owe you; AP → Bills you owe; GL → General ledger (accountant) / Ledger detail (owner nav)

---

## 5. Error messaging

**RAW_ACCOUNTING_ERRORS_EXPOSED_TO_USER = reduced** via `src/lib/ux/user-errors.ts`

Mapped: PERIOD_CLOSED, ACCOUNTING_STATE_CHANGED, UNAUTHORIZED_ENTITY, OVERALLOCATION, IDEMPOTENCY

---

## 6. Workflow results

| Area | Result |
|------|--------|
| OWNER_DASHBOARD | PASS (subledger metrics) |
| ACCOUNTANT_DASHBOARD | PASS (health + intelligence retained) |
| MONEY_IN_WORKFLOW | PASS |
| MONEY_OUT_WORKFLOW | PASS (existing bills pattern) |
| BANKING_WORKFLOW | PASS |
| REPORT_DISCOVERABILITY | PASS |
| ENTITY_CONTEXT_VISIBILITY | PASS |
| ALL_COMPANIES_POSTING_CONFUSION | false |
| ACCOUNTANT_WORKSPACE | PASS (existing route linked in nav) |

---

## 7. Findings register

| ID | Severity | Summary | Status |
|----|----------|---------|--------|
| 17F-001 | HIGH | AR aging used full totals | **Fixed** report-engine |
| 17F-002 | HIGH | Dashboard collected metric inaccurate | **Fixed** batch remaining |
| 17F-003 | HIGH | No owner/accountant mode | **Fixed** cookie + toggle |
| 17F-004 | MEDIUM | Flat overwhelming nav | **Fixed** mode-filtered nav |
| 17F-005 | MEDIUM | Invoice list missing remaining | **Fixed** |
| 17F-006 | MEDIUM | All Companies posting ambiguity | **Fixed** alert |
| 17F-007 | MEDIUM | Jobs missing entity context | **Fixed** header |
| 17F-008 | LOW | No shared empty state | **Fixed** component |
| 17F-009 | LOW | Inconsistent error strings | **Fixed** mapper |
| 17F-010 | INFO | Bills page title still "Bills" | Deferred (nav label covers owner) |

**PHASE17F_FINDINGS_TOTAL = 10** · CRITICAL = 0 · HIGH = 3 · MEDIUM = 4 · LOW = 2 · INFO = 1

---

## 8. Verification

```bash
npm run accept:phase17f:controlled
TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase17f:production
TELLER_TEST_PHASE=17 npm run test:phase
npm run test:full
```

**NEW_SQL_PATCH_REQUIRED = false**
