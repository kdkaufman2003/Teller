# Phase 17C — Reliability, Idempotency, Concurrency & Failure Recovery

**Status:** Code complete · **Patch 052 requires manual application before production close**

**Principle:** The same economic event must not post twice. A partial failure must not leave half-posted accounting.

---

## 1. Reliability threat model (summary)

| Operation | Retryable | Idempotency key | Unique constraint | Locking | Atomic RPC | Partial failure | Double-post risk | Recovery | Severity |
|-----------|-----------|-----------------|-------------------|---------|------------|-----------------|------------------|----------|----------|
| Invoice open/post | Yes | Server-derived payment key (17C) | Entity doc number | No | Journal RPC only | **HIGH** multi-step | Medium without key | Replay returns prior payment | HIGH→MEDIUM |
| Bill pay (multi) | Yes | `billPaymentIdempotencyKey` + DB column (052) | Payment idempotency (052) | Trigger capacity (052) | Journal RPC only | **HIGH** multi-step | Medium | Replay payment row | HIGH→MEDIUM |
| Payment allocation | Yes | Partial | `(payment, doc, kind)` | Trigger (052) | Deposit apply RPC | Medium | Medium | DB trigger rejects | MEDIUM |
| Deposit receive/apply | Yes | `receipt_event_id` / `application_event_id` | Partial unique | `FOR UPDATE` in RPC | Yes | Low | Low | RPC duplicate flag | LOW |
| Credit apply | Yes | None (17C-003) | Trigger capacity (052) | No | No | Medium | Medium | Trigger rejects over-apply | MEDIUM |
| Bank ingestion | Yes | Provider external ID | `(org, account, external_txn_id)` | RPC | Import RPC | Low | Low | Skip duplicate | LOW |
| Bank categorize/match/transfer | Yes | `idempotency_event_id` + deterministic seed (17C) | Partial unique | RPC locks | Yes | Low | Low | RPC `duplicate` | LOW |
| Inventory / GRNI | Yes | Required movement/settlement keys | `(org, idempotency_key)` | `FOR UPDATE` | Yes | Low | Low | RPC replay | LOW |
| Intercompany / settlement | Yes | Optional client key | Partial unique | `FOR UPDATE` | Yes | Low | Low | RPC replay | LOW |
| Recurring / schedules | Yes | `schedule:{id}:{date}` | Unique occurrence | Claim update (17C) | No | Medium | Medium | Occurrence unique + claim | MEDIUM |
| HFAC webhooks | Yes | `event_id` PK | PK | Claim lifecycle (052) | Handler-dependent | Medium→Low | Medium→Low | processed/failed status | MEDIUM→LOW |
| Period close | Yes | Implicit `(org, period, close)` | Event row | Advisory lock | Yes | Low | Low | Return existing | LOW |
| Document numbering | N/A | Server-assigned | `(entity, kind, number)` | Unique index | Partial | Low | Low | Insert conflict | LOW |

Full operation inventory aligns with Phase 17A diagnostic; 17C hardens the highest-risk retry paths.

---

## 2. Teller idempotency standard

**TELLER_IDEMPOTENCY_STANDARD = DOCUMENTED**

1. **Stable event identity** — Every retryable economic action carries a stable key: client-supplied (`idempotencyKey`, `*EventId`) or server-derived deterministic UUID from `src/lib/reliability/idempotency.ts`.
2. **DB enforcement preferred** — Unique partial indexes on `(organization_id, idempotency_key)` or domain-specific event UUID columns.
3. **Claim before work** — Webhooks and schedulers claim rows (`pending` → process → `processed`/`failed`) before side effects.
4. **Replay contract** — Duplicate requests return the same economic IDs with `duplicate: true` / `alreadyProcessed: true`; never a second journal.
5. **Capacity guards** — Allocation triggers (patch 052) reject over-application even under concurrency.
6. **No amount/date dedupe** — Never dedupe solely on amount, date, or party; keys must identify the *intent*.

---

## 3. Canonical idempotency key fields

**CANONICAL_IDEMPOTENCY_KEY_FIELDS =**

| Field | Table / usage |
|-------|----------------|
| `idempotency_key` | Payments (052), schedules, recurring runs, accrual settlements, inventory, GRNI, payroll, tax, intercompany, eliminations |
| `receipt_event_id` | Customer deposit receipt |
| `application_event_id` | Deposit apply allocations |
| `reversal_event_id` / `refund_event_id` / `writeoff_event_id` | Settlement RPCs |
| `idempotency_event_id` | Bank match, categorize, transfer |
| `external_source` + `external_id` | Integration payments, HFAC |
| `event_id` | HFAC webhook events (PK) |
| `provider` + `idempotency_key` | `teller_integration_events` |
| `(schedule_id, occurrence_date)` | Schedule occurrences (deterministic) |
| `(legal_entity_id, kind, number)` | Document numbering |

---

## 4. Patch 052 (manual apply required)

**File:** `supabase/patches/052_phase17c_reliability_hardening.sql`

- HFAC webhook `processing_status` lifecycle (`pending` / `processed` / `failed`)
- `teller_payments.idempotency_key` + unique partial index
- Payment allocation capacity trigger
- Document (credit) allocation capacity trigger
- Probe: `teller_phase17c_reliability_probe()`

**Do not apply automatically.** Static verify: `npm run verify:patch:052:static`

---

## 5. Code changes (17C)

| Area | Change |
|------|--------|
| Payments | `recordTellerPayment` idempotency pre-check + column insert |
| Invoice pay | `invoicePaymentIdempotencyKey` + early replay |
| Bill pay | DB `idempotency_key` (not metadata-only) |
| Banking | Deterministic `bankingOperationSeed` when client omits UUID |
| HFAC | Claim → process → mark processed/failed |
| Schedules | Atomic occurrence claim before journal post |
| Helpers | `src/lib/reliability/idempotency.ts` |

---

## 6. Transaction boundaries

| Operation | DB transaction? | RPC? | Multi HTTP? | Partial failure? | Recommendation |
|-----------|-----------------|---------|-------------|------------------|----------------|
| `postJournal` | Yes (RPC) | `teller_post_journal` | No | No | Canonical |
| `postInvoicePaid` | No | Partial | Yes | **Yes** | Future RPC wrap (17C-001) |
| `postMultiBillPayment` | No | Partial | Yes | **Yes** | Future RPC wrap (17C-002) |
| Deposit apply | Yes | Yes | No | No | Gold standard |
| Intercompany | Yes | Yes | No | No | Gold standard |
| GRNI settle | Yes | Yes | No | No | Gold standard |
| Credit apply | No | Trigger only | Yes | Medium | Future RPC (17C-003) |
| Schedule post | No | Partial | Yes | Medium | Claim reduces race (17C-004) |

**PARTIAL_ACCOUNTING_COMMIT_PATHS = 3** (invoice pay, multi bill pay, credit apply — documented, mitigated where possible)

---

## 7. Retry error semantics

**RETRY_ERROR_SEMANTICS = DOCUMENTED**

| Code | Meaning | Retry? |
|------|---------|--------|
| 400 | Validation | No |
| 401/403 | Auth | No |
| 409 | Conflict / idempotency replay / concurrency | Safe replay with same key |
| 422 | Accounting rule rejection | No |
| 5xx | Infrastructure | Yes with same key |

---

## 8. Failure recovery model

**ACCOUNTING_FAILURE_RECOVERY_MODEL = DOCUMENTED**

**Allowed:** Safe retry with same idempotency key · Idempotent replay · Reversal RPC · Correction journal · Resume failed webhook (`failed` → reclaim)

**Forbidden:** Manual DB mutation · Deleting posted history · Rewriting journal lines

---

## 9. Findings register

| ID | Severity | Summary | Status |
|----|----------|---------|--------|
| **17C-001** | HIGH | `postInvoicePaid` multi-step without DB transaction | Mitigated: idempotency pre-check; RPC wrap deferred |
| **17C-002** | HIGH | `postMultiBillPayment` multi-step without DB transaction | Mitigated: DB idempotency key + pre-check |
| **17C-003** | MEDIUM | Credit apply lacks application event id + atomic RPC | Mitigated: patch 052 capacity trigger |
| **17C-004** | MEDIUM | Schedule occurrence concurrent post race | Fixed: atomic claim |
| **17C-005** | MEDIUM | HFAC record-before-process blocked retries | Fixed: patch 052 lifecycle + claim code |
| **17C-006** | MEDIUM | Banking UI omitted stable event id on retry | Fixed: deterministic seed fallback |
| **17C-007** | MEDIUM | Deposit routes allowed optional event UUID | Fixed: deterministic seed in `deposits.ts` |
| **17C-010** | MEDIUM | Credit apply lacks application event id | Open: capacity trigger only (052) |
| **17C-008** | LOW | Manual ledger/adjustment POST routes unkeyed | Accepted: admin actions, low volume |
| **17C-009** | LOW | Audit events best-effort after commit | Accepted: non-economic |

**PHASE17C_FINDINGS_TOTAL = 9** · CRITICAL = 0 · HIGH = 2 · MEDIUM = 5 · LOW = 2

---

## 10. Production verification

```bash
npm run verify:patch:052:static
TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase17c:production
TELLER_CONTROLLED_PROD_TEST=1 npm run accept:phase17c:controlled
TELLER_CONTROLLED_PROD_TEST=1 npm run accept:phase17c:controlled -- --rerun-2
```

---

## 11. Close checklist

17C closes when:

- [x] Threat model documented
- [x] Idempotency standard documented
- [x] Patch 052 prepared + static verified
- [x] Code fixes for payment, banking, HFAC, schedules
- [x] Controlled acceptance script (~55 scenarios)
- [x] Production verify script (read-only)
- [x] Unit tests (`phase17c.test.ts`)
- [ ] **Patch 052 manually applied and probe PASS**
- [ ] Production verify PASS (after patch)
- [ ] Controlled acceptance PASS ×2 (after patch)
- [ ] Full release gate PASS

**PHASE_17C_DB_VERIFIED = false until user confirms patch 052 applied.**
