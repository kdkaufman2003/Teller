import type { AccountSeed } from "@/types";

export type QuestionOption = {
  value: string;
  label: string;
  description?: string;
};

export type IndustryQuestion = {
  id: string;
  prompt: string;
  help?: string;
  type: "select" | "multiselect" | "boolean" | "text" | "number";
  options?: QuestionOption[];
  default?: unknown;
  required?: boolean;
  /** Grouping for setup wizard sections */
  section?: "business" | "accounting" | "operations" | "integrations";
  /** Hide unless this returns true (in addition to built-in rules in onboarding.ts) */
  when?: (answers: IndustryAnswers) => boolean;
};

export type IndustryAnswers = Record<string, unknown>;

export type IndustryPack = {
  id: string;
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  recommended?: boolean;
  /** Grouping label for setup wizard (e.g. Trades & field service) */
  category?: string;
  questions: IndustryQuestion[];
  resolve: (answers: IndustryAnswers) => {
    modules: string[];
    labels: Record<string, string>;
    accounts: AccountSeed[];
  };
};

export type ModuleId = string;

export const CORE_MODULES = [
  "dashboard",
  "invoices",
  "expenses",
  "customers",
  "accounts",
  "ledger",
] as const;

export type CoreModule = (typeof CORE_MODULES)[number];
