import { TELLER_HFAC_ORG_ID } from "@/lib/integration/controlled-prod-test";

/** HFAC may eventually supply technician/time data — Teller remains accounting system of record. */
export function hfacPayrollIntegrationAllowed(organizationId: string): boolean {
  return organizationId !== TELLER_HFAC_ORG_ID;
}

export function assertHfacPayrollHardRefusal(organizationId: string): void {
  if (organizationId === TELLER_HFAC_ORG_ID) {
    throw new Error("HFAC organization is read-only for payroll mutations");
  }
}

export type HfacLaborPayload = {
  technicianId: string;
  jobId?: string | null;
  clockIn?: string;
  clockOut?: string;
  hours: number;
};

/** Normalize future HFAC technician/time payloads into provider-neutral labor entries. */
export function normalizeHfacLaborPayload(payload: HfacLaborPayload) {
  return {
    provider: "hfac",
    externalWorkerId: payload.technicianId,
    externalEntryId: `${payload.technicianId}:${payload.clockIn ?? "manual"}:${payload.hours}`,
    jobId: payload.jobId ?? null,
    hours: payload.hours,
    source: "hfac",
  };
}
