import { roundMoney } from "../payment-fees";
import type { LaborAllocationInput, LaborType } from "./types";

export type BurdenAllocationRow = {
  destinationKey: string;
  jobId: string | null;
  laborType: LaborType;
  grossAmount: number;
  burdenAmount: number;
};

/** Proportional employer burden by gross wage destination. Employee withholding excluded. */
export function allocateEmployerBurden(input: {
  totalEmployerBurden: number;
  destinations: Array<{ key: string; jobId: string | null; laborType: LaborType; grossAmount: number }>;
}): BurdenAllocationRow[] {
  const eligible = input.destinations.filter((row) => row.grossAmount > 0.009);
  const totalGross = roundMoney(eligible.reduce((sum, row) => sum + row.grossAmount, 0));
  if (totalGross <= 0.009 || input.totalEmployerBurden <= 0.009) {
    return eligible.map((row) => ({
      destinationKey: row.key,
      jobId: row.jobId,
      laborType: row.laborType,
      grossAmount: row.grossAmount,
      burdenAmount: 0,
    }));
  }

  let allocated = 0;
  const rows: BurdenAllocationRow[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const row = eligible[i]!;
    const isLast = i === eligible.length - 1;
    const burdenAmount = isLast
      ? roundMoney(input.totalEmployerBurden - allocated)
      : roundMoney((row.grossAmount / totalGross) * input.totalEmployerBurden);
    allocated = roundMoney(allocated + burdenAmount);
    rows.push({
      destinationKey: row.key,
      jobId: row.jobId,
      laborType: row.laborType,
      grossAmount: row.grossAmount,
      burdenAmount,
    });
  }
  return rows;
}

export function isDirectLabor(laborType: LaborType): boolean {
  return laborType === "direct";
}

export function isIndirectLabor(laborType: LaborType): boolean {
  return laborType === "indirect" || laborType === "overhead" || laborType === "training";
}

export function summarizeLaborAllocations(allocations: LaborAllocationInput[]) {
  let directGross = 0;
  let indirectGross = 0;
  let unallocatedGross = 0;
  let assignedGross = 0;

  for (const row of allocations) {
    assignedGross = roundMoney(assignedGross + row.grossAmount);
    if (row.laborType === "unallocated") {
      unallocatedGross = roundMoney(unallocatedGross + row.grossAmount);
    } else if (isDirectLabor(row.laborType)) {
      if (!row.jobId) {
        unallocatedGross = roundMoney(unallocatedGross + row.grossAmount);
      } else {
        directGross = roundMoney(directGross + row.grossAmount);
      }
    } else {
      indirectGross = roundMoney(indirectGross + row.grossAmount);
    }
  }

  return {
    directGross,
    indirectGross,
    unallocatedGross,
    assignedGross,
    totalGross: assignedGross,
  };
}

export function costClassificationForLaborType(laborType: LaborType): "direct" | "indirect" | "" {
  if (isDirectLabor(laborType)) return "direct";
  if (isIndirectLabor(laborType) || laborType === "pto" || laborType === "unallocated") return "indirect";
  return "";
}

export function validateLaborAllocationOrgScope(input: {
  organizationId: string;
  workerOrgId: string;
  jobOrgId?: string | null;
}): void {
  if (input.workerOrgId !== input.organizationId) {
    throw new Error("Worker belongs to a different organization");
  }
  if (input.jobOrgId && input.jobOrgId !== input.organizationId) {
    throw new Error("Job belongs to a different organization");
  }
}

export function mergeBurdenIntoLaborSummary(
  allocations: LaborAllocationInput[],
  burdenRows: BurdenAllocationRow[],
) {
  const burdenByKey = new Map(burdenRows.map((row) => [row.destinationKey, row.burdenAmount]));
  let directBurden = 0;
  let indirectBurden = 0;
  let unassignedBurden = 0;

  for (let i = 0; i < allocations.length; i++) {
    const row = allocations[i]!;
    const key = `${row.workerId}:${row.jobId ?? "none"}:${row.laborType}:${i}`;
    const burden = burdenByKey.get(key) ?? 0;
    if (row.laborType === "unallocated" || !row.jobId) {
      unassignedBurden = roundMoney(unassignedBurden + burden);
    } else if (isDirectLabor(row.laborType)) {
      directBurden = roundMoney(directBurden + burden);
    } else {
      indirectBurden = roundMoney(indirectBurden + burden);
    }
  }

  return { directBurden, indirectBurden, unassignedBurden };
}
