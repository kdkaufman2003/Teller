# Teller Release Notes — Phase 17 Final

**TELLER_RELEASE_IDENTIFIER = Phase17-Final**  
**RELEASE_NOTES = COMPLETE**

Production URL: https://teller-indol.vercel.app  
Database patches through: **054**

---

## Summary

Phase 17 completes Teller's hardening and certification program on top of the Phase 16 multi-entity accounting foundation. This release is **certification-focused** — no new accounting features; improved security, reliability, performance, operations, UX, and end-to-end lifecycle verification.

## For business owners

- **Owner mode** — Simpler navigation and plain-language labels ("Money in", "Customers owe you") without changing accounting underneath.
- **Accountant mode** — Full ledger, workspace, and technical terminology for bookkeepers.
- **Mode toggle** — Switch presentation mode during session; accounting semantics unchanged.

## For accountants

- **AR aging accuracy** — Aging and dashboard collected metrics use authoritative subledger remaining balances.
- **Multi-entity** — Company switcher, All Companies reporting (view-only), intercompany and consolidation flows certified.
- **Month-end close** — Per-entity period controls certified.

## Platform hardening

| Slice | Focus |
|-------|--------|
| **17A** | Accounting integrity diagnostics |
| **17B** | Security — journal insert blocks, tenant isolation |
| **17C** | Reliability — idempotency, allocation guards |
| **17D** | Performance — pagination, indexes (patch 053) |
| **17E** | Operations — audit immutability, `/api/ready`, ops status (patch 054) |
| **17F** | Owner/accountant UX |
| **17G** | Full E2E lifecycle certification (113 scenarios) |
| **17H** | Final deployment and launch readiness |

## Modules certified (E2E)

Accounts receivable · customer deposits · credits · refunds · write-offs · accounts payable · purchasing · inventory/GRNI · banking · expenses · jobs · fixed assets · payroll accounting import · sales tax (MO/KS) · recurring journals · accruals · manual journals · month-end close · financial statements · multi-entity · intercompany · consolidation · eliminations · HFAC integration

## Database

Patches **051–054** must be manually applied in Supabase (already verified on production). No Phase 17G/17H DB patch required.

## Known limitations

See `docs/LAUNCH-KNOWN-LIMITATIONS.md`.

## Support

See `docs/LAUNCH-SUPPORT-RUNBOOK.md`.
