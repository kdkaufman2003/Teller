import type { IndustryAnswers, IndustryPack, IndustryQuestion } from "./types";

export type OnboardingContext = {
  enableIntegrations?: boolean;
};

export const ONBOARDING_SECTION_LABELS: Record<string, string> = {
  business: "About your business",
  accounting: "Accounting preferences",
  operations: "Operations & tracking",
  integrations: "Integrations",
};

const BUSINESS_MODEL_DEFAULTS: Record<string, Partial<IndustryAnswers>> = {
  dealer: {
    revenueStreams: ["equipment", "parts"],
    customerNoun: "dealers",
    trackJobs: false,
    trackInventory: true,
  },
  contractor: {
    revenueStreams: ["equipment", "labor", "service", "parts"],
    customerNoun: "homeowners",
    trackJobs: true,
  },
  service: {
    revenueStreams: ["service", "parts", "maintenance"],
    customerNoun: "homeowners",
    trackJobs: true,
    trackInventory: false,
  },
  mixed: {
    revenueStreams: ["equipment", "labor", "service", "parts", "maintenance"],
    customerNoun: "customers",
    trackJobs: true,
  },
};

export function collectTaxOn(answers: IndustryAnswers): boolean {
  const collect = answers.collectTax;
  return collect !== false && collect !== "false" && collect !== "no";
}

export function revenueStreamsInclude(answers: IndustryAnswers, stream: string): boolean {
  const streams = answers.revenueStreams;
  if (!Array.isArray(streams)) return false;
  return streams.map(String).includes(stream);
}

/** Apply sensible defaults when the owner picks a business model. */
export function applyBusinessModelDefaults(
  businessModel: unknown,
  current: IndustryAnswers,
): IndustryAnswers {
  const key = String(businessModel || "");
  const patch = BUSINESS_MODEL_DEFAULTS[key];
  if (!patch) return current;
  return { ...current, ...patch };
}

export function isQuestionVisible(
  question: IndustryQuestion,
  answers: IndustryAnswers,
  context: OnboardingContext = {},
): boolean {
  if (question.id === "connectQuoter" || question.id === "connectHfac") {
    return Boolean(context.enableIntegrations);
  }
  if (question.id === "taxRate") {
    return collectTaxOn(answers);
  }
  if (question.id === "warrantyReserve") {
    return (
      revenueStreamsInclude(answers, "warranty") ||
      revenueStreamsInclude(answers, "equipment")
    );
  }
  if (question.id === "trackInventory") {
    const model = String(answers.businessModel || "");
    return model === "dealer" || model === "mixed" || model === "contractor";
  }
  if (question.when && !question.when(answers)) return false;
  return true;
}

export function visibleQuestions(
  pack: IndustryPack,
  answers: IndustryAnswers,
  context: OnboardingContext = {},
): IndustryQuestion[] {
  return pack.questions.filter((question) => isQuestionVisible(question, answers, context));
}

export function questionsBySection(
  pack: IndustryPack,
  answers: IndustryAnswers,
  context: OnboardingContext = {},
): { section: string; label: string; questions: IndustryQuestion[] }[] {
  const visible = visibleQuestions(pack, answers, context);
  const order: string[] = [];
  const groups = new Map<string, IndustryQuestion[]>();

  for (const question of visible) {
    const section = question.section ?? "business";
    if (!groups.has(section)) {
      groups.set(section, []);
      order.push(section);
    }
    groups.get(section)!.push(question);
  }

  return order.map((section) => ({
    section,
    label: ONBOARDING_SECTION_LABELS[section] ?? section,
    questions: groups.get(section) ?? [],
  }));
}
