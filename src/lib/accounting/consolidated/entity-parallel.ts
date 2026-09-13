import { mapWithBoundedConcurrency } from "@/lib/performance/bounded-parallel";
import type { ConsolidationScopeEntity } from "./types";

/** Max concurrent entity GL loads for consolidated reports (Phase 17D). */
export const CONSOLIDATED_ENTITY_CONCURRENCY = 4;

export async function mapConsolidatedEntities<T>(
  entities: ConsolidationScopeEntity[],
  worker: (entity: ConsolidationScopeEntity) => Promise<T>,
): Promise<T[]> {
  return mapWithBoundedConcurrency(entities, CONSOLIDATED_ENTITY_CONCURRENCY, worker);
}
