import { generalPack } from "./general";
import { hvacTradesPack } from "./hvac-trades";
import { saasPack } from "./saas";
import type { IndustryAnswers, IndustryPack } from "./types";

export const industryPacks: IndustryPack[] = [
  hvacTradesPack,
  saasPack,
  generalPack,
];

export function getIndustryPack(id: string | undefined | null): IndustryPack {
  return industryPacks.find((pack) => pack.id === id) ?? generalPack;
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
