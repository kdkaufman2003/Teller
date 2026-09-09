"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ScenarioBuilder } from "@/components/planning/ScenarioBuilder";
import { routes } from "@/lib/routes";

export default function NewScenarioPage() {
  const router = useRouter();

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">New scenario</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Build a what-if overlay on a forecast version. Preview is read-only until you save.
        </p>
      </div>

      <ScenarioBuilder onSaved={(scenarioId) => router.push(`${routes.planningScenarios}/${scenarioId}`)} />

      <Link href={routes.planningScenarios} className="inline-block text-sm text-navy hover:underline">
        ← All scenarios
      </Link>
    </div>
  );
}
