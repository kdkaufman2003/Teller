import { generalPack } from "./general";
import { saasPack } from "./saas";
import { LEGACY_HVAC_TRADES_ID } from "./trades-base";
import { tradeIndustryPacks, tradesHvacPack } from "./trades-packs";
import type { IndustryAnswers, IndustryPack } from "./types";

export { isTradesIndustryId } from "./trades-base";

export const industryPacks: IndustryPack[] = [
  ...tradeIndustryPacks,
  { ...saasPack, category: "Software & subscriptions" },
  { ...generalPack, category: "Other" },
];

export function getIndustryPack(id: string | undefined | null): IndustryPack {
  if (!id || id === LEGACY_HVAC_TRADES_ID) {
    return tradesHvacPack;
  }
  return industryPacks.find((pack) => pack.id === id) ?? generalPack;
}

export function industryPacksByCategory(): { category: string; packs: IndustryPack[] }[] {
  const groups = new Map<string, IndustryPack[]>();
  for (const pack of industryPacks) {
    const category = pack.category ?? "Other";
    const list = groups.get(category) ?? [];
    list.push(pack);
    groups.set(category, list);
  }
  return Array.from(groups.entries()).map(([category, packs]) => ({ category, packs }));
}

export function defaultAnswers(pack: IndustryPack): IndustryAnswers {
  const answers: IndustryAnswers = {};
  for (const question of pack.questions) {
    if (question.default !== undefined) answers[question.id] = question.default;
  }
  return answers;
}

export function resolveIndustry(industryId: string, answers: IndustryAnswers) {
  const pack = getIndustryPack(industryId);
  return { pack, ...pack.resolve(answers) };
}
