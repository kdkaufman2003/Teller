export type AccountType =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "cogs"
  | "expense";

export type PartyKind = "customer" | "vendor" | "both";
export type DocumentKind =
  | "invoice"
  | "bill"
  | "expense"
  | "credit_memo"
  | "vendor_credit";
export type DocumentStatus =
  | "draft"
  | "open"
  | "partially_paid"
  | "paid"
  | "partially_applied"
  | "applied"
  | "void";
export type JobStatus =
  | "estimate"
  | "scheduled"
  | "in_progress"
  | "complete"
  | "invoiced"
  | "cancelled";
export type JobType = "install" | "service" | "maintenance" | "warranty" | "other";
export type ProfileRole = "owner" | "admin" | "bookkeeper" | "viewer";

export type AccountSeed = {
  code: string;
  name: string;
  type: AccountType;
  subtype?: string;
  industry_tag?: string;
};

export type TellerAccount = AccountSeed & {
  id: string;
  organization_id: string;
  is_system: boolean;
  archived: boolean;
};

export type TellerParty = {
  id: string;
  organization_id: string;
  kind: PartyKind;
  name: string;
  email: string;
  phone: string;
  notes: string;
  external_source: string | null;
  external_id: string | null;
  created_at: string;
};

export type TellerJob = {
  id: string;
  organization_id: string;
  job_number: string;
  name: string;
  party_id: string | null;
  status: JobStatus;
  job_type: JobType;
  quoted_amount: number;
  address: string;
  external_source: string | null;
  external_id: string | null;
  created_at: string;
};

export type TellerDocument = {
  id: string;
  organization_id: string;
  kind: DocumentKind;
  number: string;
  party_id: string | null;
  job_id: string | null;
  status: DocumentStatus;
  issue_date: string;
  due_date: string | null;
  subtotal: number;
  tax: number;
  total: number;
  amount_paid: number;
  memo: string;
  external_source: string | null;
  external_id: string | null;
  created_at: string;
};

export type TellerDocumentLine = {
  id: string;
  document_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  account_id: string | null;
  item_type: string;
  sort_order: number;
};

export type OrganizationSource = "direct" | "hfac" | "partner";

export type TellerOrganization = {
  id: string;
  name: string;
  legal_name: string;
  industry_id: string;
  partner_id: string | null;
  organization_source: OrganizationSource;
  phone: string;
  timezone: string;
  currency: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  setup_completed_at: string | null;
};

export type TellerLocation = {
  id: string;
  organization_id: string;
  name: string;
  is_primary: boolean;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  created_at: string;
  updated_at: string;
};

export type TellerSettings = {
  organization_id: string;
  answers: Record<string, unknown>;
  modules: string[];
  labels: Record<string, string>;
};

export type TellerProfile = {
  id: string;
  organization_id: string | null;
  email: string;
  full_name: string;
  role: ProfileRole;
};

export type SessionContext = {
  userId: string;
  email: string;
  profile: TellerProfile | null;
  organization: TellerOrganization | null;
  settings: TellerSettings | null;
};
