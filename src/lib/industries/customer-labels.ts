import type { QuestionOption } from "./types";

const LABELS: Record<string, { plural: string; singular: string }> = {
  customers: { plural: "Customers", singular: "Customer" },
  clients: { plural: "Clients", singular: "Client" },
  accounts: { plural: "Accounts", singular: "Account" },
  tenants: { plural: "Tenants", singular: "Tenant" },
  subscribers: { plural: "Subscribers", singular: "Subscriber" },
  members: { plural: "Members", singular: "Member" },
  users: { plural: "Users", singular: "User" },
  organizations: { plural: "Organizations", singular: "Organization" },
  workspaces: { plural: "Workspaces", singular: "Workspace" },
  dealers: { plural: "Dealers", singular: "Dealer" },
  contractors: { plural: "Contractors", singular: "Contractor" },
  homeowners: { plural: "Homeowners", singular: "Homeowner" },
  businesses: { plural: "Businesses", singular: "Business" },
  properties: { plural: "Properties", singular: "Property" },
  locations: { plural: "Locations", singular: "Location" },
  patients: { plural: "Patients", singular: "Patient" },
  guests: { plural: "Guests", singular: "Guest" },
};

function option(value: keyof typeof LABELS | string): QuestionOption {
  const labels = LABELS[value];
  return {
    value,
    label: labels?.plural ?? value.charAt(0).toUpperCase() + value.slice(1),
  };
}

export const SAAS_CUSTOMER_NOUN_OPTIONS: QuestionOption[] = [
  option("customers"),
  option("accounts"),
  option("tenants"),
  option("subscribers"),
  option("members"),
  option("users"),
  option("organizations"),
  option("workspaces"),
  option("clients"),
];

export const TRADES_CUSTOMER_NOUN_OPTIONS: QuestionOption[] = [
  option("customers"),
  option("clients"),
  option("homeowners"),
  option("businesses"),
  option("dealers"),
  option("contractors"),
  option("properties"),
  option("locations"),
  option("accounts"),
];

export const GENERAL_CUSTOMER_NOUN_OPTIONS: QuestionOption[] = [
  option("customers"),
  option("clients"),
  option("accounts"),
  option("businesses"),
  option("members"),
  option("patients"),
  option("guests"),
];

export function formatCustomerLabels(customerNoun: string): {
  customer: string;
  customerSingular: string;
} {
  const key = customerNoun.trim().toLowerCase();
  const known = LABELS[key];
  if (known) {
    return { customer: known.plural, customerSingular: known.singular };
  }
  const capitalized = key.charAt(0).toUpperCase() + key.slice(1);
  return {
    customer: capitalized,
    customerSingular: capitalized.replace(/s$/, "") || "Customer",
  };
}
