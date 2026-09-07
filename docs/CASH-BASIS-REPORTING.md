# Cash-Basis Reporting (Phase 10 V1)

Cash-basis financial reports are **derived presentation only**. The general ledger remains accrual-based and is the canonical accounting truth for close, trial balance, and subledger integrity.

## Revenue

| Event | Cash-basis recognition |
|-------|------------------------|
| Unpaid invoice | No revenue |
| Partial invoice payment | Proportional revenue by line (deterministic cent rounding) |
| Full payment | Full proportional revenue |
| Customer deposit receipt | **Not revenue** (liability) |
| Deposit applied to invoice | Revenue on **application/payment date**, not deposit date |
| Customer credit applied before payment | Reduces cash revenue when payment/allocation occurs |
| Customer credit after cash recognition | Handled via reversal/allocation events; no double reduction |
| Cash refund to customer | Negative revenue on refund payment date |

Recognition date: `teller_payments.payment_date` for payment allocations (`invoice_payment`, `deposit_apply`).

## Expenses

| Event | Cash-basis recognition |
|-------|------------------------|
| Unpaid vendor bill | No expense |
| Partial bill payment | Proportional expense by line |
| Bill paid (cash/check/ACH) | Expense on payment date |
| Direct cash expense (`paid=true`, credits bank) | Expense on document `issue_date` |
| Credit card purchase (credits `credit_card` liability) | Expense on document `issue_date` |
| Credit card payment (settles liability) | **No additional expense** |
| Vendor credit before payment | Reduces cash expense at payment |
| Vendor credit after payment | Via allocation/reversal; no double count |
| Vendor refund | Negative expense on refund date |

## Excluded from cash P&L

- Depreciation (`fixed-asset-depreciation`, `depreciation`)
- Non-cash adjusting entries (`adjustment` source_kind without cash settlement)
- Bad debt write-offs (`invoice-writeoff`)
- Fixed asset purchases (investing; not ordinary P&L expense)
- Internal transfers between bank accounts

## Multi-line documents

Payment/credit amounts are allocated across document lines in proportion to line amounts. Remainder cents assigned to the largest line (deterministic).

## Credit card semantics

When an expense posts Dr Expense / Cr Credit Card Liability, expense is recognized at charge date. Subsequent card payments Dr Credit Card / Cr Bank affect cash flow only, not P&L.
