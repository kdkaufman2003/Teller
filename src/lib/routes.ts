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
  jobs: "/app/jobs",
  accounts: "/app/accounts",
  ledger: "/app/ledger",
  reports: "/app/reports",
  settings: "/app/settings",
} as const;

export function invoicePath(id: string) {
  return `${routes.invoices}/${id}`;
}

export function expensePath(id: string) {
  return `${routes.expenses}/${id}`;
}

export function jobPath(id: string) {
  return `${routes.jobs}/${id}`;
}
