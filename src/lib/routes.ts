export const routes = {
  home: "/",
  login: "/login",
  signup: "/signup",
  setup: "/setup",
  callback: "/auth/callback",
  app: "/app",
  invoices: "/app/invoices",
  invoiceNew: "/app/invoices/new",
  customers: "/app/customers",
  expenses: "/app/expenses",
  bills: "/app/bills",
  billNew: "/app/bills/new",
  creditMemos: "/app/credit-memos",
  vendorCredits: "/app/vendor-credits",
  billPay: "/app/bills/pay",
  jobs: "/app/jobs",
  jobNew: "/app/jobs/new",
  jobsUnassigned: "/app/jobs/unassigned",
  accounts: "/app/accounts",
  ledger: "/app/ledger",
  accounting: "/app/accounting",
  accountingClose: "/app/accounting/close",
  accountingAdjustments: "/app/accounting/adjustments",
  accountingTrialBalance: "/app/accounting/trial-balance",
  accountingRecurringJournals: "/app/accounting/recurring-journals",
  reports: "/app/reports",
  banking: "/app/banking",
  bankingReconcile: "/app/banking/reconcile",
  bankingReconciliations: "/app/banking/reconciliations",
  vendors: "/app/vendors",
  purchasing: "/app/purchasing",
  purchaseOrders: "/app/purchasing/purchase-orders",
  apDashboard: "/app/accounting/ap",
  assets: "/app/assets",
  assetNew: "/app/assets/new",
  assetsDepreciation: "/app/assets/depreciation",
  assetsReconciliation: "/app/assets/reconciliation",
  assetCategories: "/app/assets/categories",
  fixedAssetSettings: "/app/settings/fixed-assets",
  settings: "/app/settings",
} as const;

export function invoicePath(id: string) {
  return `${routes.invoices}/${id}`;
}

export function expensePath(id: string) {
  return `${routes.expenses}/${id}`;
}

export function customerPath(id: string) {
  return `${routes.customers}/${id}`;
}

export function billPath(id: string) {
  return `${routes.bills}/${id}`;
}

export function creditMemoPath(id: string) {
  return `${routes.creditMemos}/${id}`;
}

export function vendorCreditPath(id: string) {
  return `${routes.vendorCredits}/${id}`;
}

export function jobPath(id: string) {
  return `${routes.jobs}/${id}`;
}

export function assetPath(id: string) {
  return `${routes.assets}/${id}`;
}

export function bankingReconcilePath(id?: string) {
  return id ? `${routes.bankingReconcile}/${id}` : routes.bankingReconcile;
}

export function bankingReconciliationPath(id: string) {
  return `${routes.bankingReconciliations}/${id}`;
}

export function vendorPath(id: string) {
  return `${routes.vendors}/${id}`;
}

export function purchaseOrderPath(id: string) {
  return `${routes.purchaseOrders}/${id}`;
}

export function accountingClosePeriodPath(period: string) {
  return `${routes.accountingClose}/${period}`;
}

export function accountingAdjustmentPath(id: string) {
  return `${routes.accountingAdjustments}/${id}`;
}
