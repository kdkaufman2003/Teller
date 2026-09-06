import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "./audit";
import { allocateJobNumber } from "./job-numbering";
import { buildJobProfitabilitySummary } from "./job-profitability";

export type JobStatus =
  | "draft"
  | "active"
  | "on_hold"
  | "completed"
  | "closed"
  | "cancelled";

const TERMINAL_FOR_ASSIGNMENT: JobStatus[] = ["closed", "cancelled"];

export async function assertJobAcceptsAssignment(
  supabase: SupabaseClient,
  organizationId: string,
  jobId: string | null | undefined,
) {
  if (!jobId) return;
  const { data: job } = await supabase
    .from("teller_jobs")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("id", jobId)
    .maybeSingle();
  if (!job) throw new Error("Job not found");
  if (TERMINAL_FOR_ASSIGNMENT.includes(job.status as JobStatus)) {
    throw new Error(`Job status ${job.status} does not accept new assignments`);
  }
}

export async function createJob(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    name: string;
    customerPartyId?: string | null;
    jobType?: string;
    description?: string;
    address?: string;
    serviceAddress?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postal?: string;
      country?: string;
    };
    startedAt?: string | null;
    estimatedCompletionDate?: string | null;
    originalContractAmount?: number;
    estimatedRevenue?: number;
    estimatedCost?: number;
    projectManagerUserId?: string | null;
    salespersonUserId?: string | null;
    actorId?: string | null;
  },
) {
  const jobNumber = await allocateJobNumber(supabase, input.organizationId);
  const contract = asNumber(input.originalContractAmount);
  const { data, error } = await supabase
    .from("teller_jobs")
    .insert({
      organization_id: input.organizationId,
      job_number: jobNumber,
      name: input.name.trim(),
      party_id: input.customerPartyId ?? null,
      job_type: input.jobType || "Other",
      description: input.description?.trim() || "",
      address: input.address?.trim() || input.serviceAddress?.line1 || "",
      service_address_line1: input.serviceAddress?.line1 || input.address || "",
      service_address_line2: input.serviceAddress?.line2 || "",
      service_city: input.serviceAddress?.city || "",
      service_state: input.serviceAddress?.state || "",
      service_postal: input.serviceAddress?.postal || "",
      service_country: input.serviceAddress?.country || "US",
      status: "draft",
      quoted_amount: contract,
      original_contract_amount: contract,
      estimated_revenue: asNumber(input.estimatedRevenue) || contract,
      estimated_cost: asNumber(input.estimatedCost),
      started_at: input.startedAt || null,
      estimated_completion_date: input.estimatedCompletionDate || null,
      project_manager_user_id: input.projectManagerUserId ?? null,
      salesperson_user_id: input.salespersonUserId ?? null,
      created_by: input.actorId ?? null,
      updated_by: input.actorId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create job");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "job.created",
    resourceKind: "job",
    resourceId: data.id as string,
    metadata: { jobNumber, name: input.name },
  });

  return data;
}

export async function updateJob(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    jobId: string;
    patch: Record<string, unknown>;
    actorId?: string | null;
  },
) {
  const { error } = await supabase
    .from("teller_jobs")
    .update({ ...input.patch, updated_at: new Date().toISOString(), updated_by: input.actorId ?? null })
    .eq("organization_id", input.organizationId)
    .eq("id", input.jobId);
  if (error) throw new Error(error.message);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "job.updated",
    resourceKind: "job",
    resourceId: input.jobId,
    metadata: { fields: Object.keys(input.patch) },
  });
}

export type JobCloseWarning = {
  code: string;
  message: string;
  amount?: number;
};

export async function detectJobCloseWarnings(
  supabase: SupabaseClient,
  organizationId: string,
  jobId: string,
): Promise<JobCloseWarning[]> {
  const summary = await buildJobProfitabilitySummary(supabase, organizationId, jobId);
  const warnings: JobCloseWarning[] = [];
  if (summary.accountsReceivable > 0) {
    warnings.push({
      code: "open_ar",
      message: "Open accounts receivable on job",
      amount: summary.accountsReceivable,
    });
  }
  if (summary.accountsPayable > 0) {
    warnings.push({
      code: "open_ap",
      message: "Open accounts payable on job",
      amount: summary.accountsPayable,
    });
  }
  if (summary.remainingCommittedCost > 0) {
    warnings.push({
      code: "po_commitment",
      message: "Remaining purchase order commitment",
      amount: summary.remainingCommittedCost,
    });
  }
  if (summary.customerDepositsHeld > 0) {
    warnings.push({
      code: "deposits_held",
      message: "Customer deposits held on job",
      amount: summary.customerDepositsHeld,
    });
  }
  return warnings;
}

export async function markJobCompleted(
  supabase: SupabaseClient,
  input: { organizationId: string; jobId: string; actorId?: string | null },
) {
  await updateJob(supabase, {
    organizationId: input.organizationId,
    jobId: input.jobId,
    patch: { status: "completed", completed_at: new Date().toISOString().slice(0, 10) },
    actorId: input.actorId,
  });
  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "job.completed",
    resourceKind: "job",
    resourceId: input.jobId,
    metadata: {},
  });
}

export async function closeJob(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    jobId: string;
    overrideReason?: string;
    actorId?: string | null;
  },
) {
  const warnings = await detectJobCloseWarnings(supabase, input.organizationId, input.jobId);
  if (warnings.length && !input.overrideReason?.trim()) {
    throw new Error(
      `Job close blocked: ${warnings.map((row) => row.code).join(", ")}. Override reason required.`,
    );
  }

  await updateJob(supabase, {
    organizationId: input.organizationId,
    jobId: input.jobId,
    patch: {
      status: "closed",
      closed_at: new Date().toISOString(),
      close_override_reason: input.overrideReason?.trim() || "",
    },
    actorId: input.actorId,
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "job.closed",
    resourceKind: "job",
    resourceId: input.jobId,
    metadata: { warnings, overrideReason: input.overrideReason?.trim() || null },
  });
}

export async function reopenJob(
  supabase: SupabaseClient,
  input: { organizationId: string; jobId: string; reason: string; actorId?: string | null },
) {
  if (!input.reason.trim()) throw new Error("Reopen reason is required");
  await updateJob(supabase, {
    organizationId: input.organizationId,
    jobId: input.jobId,
    patch: {
      status: "active",
      closed_at: null,
      close_override_reason: "",
    },
    actorId: input.actorId,
  });
  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "job.reopened",
    resourceKind: "job",
    resourceId: input.jobId,
    metadata: { reason: input.reason.trim() },
  });
}

export async function cancelJob(
  supabase: SupabaseClient,
  input: { organizationId: string; jobId: string; actorId?: string | null },
) {
  await updateJob(supabase, {
    organizationId: input.organizationId,
    jobId: input.jobId,
    patch: { status: "cancelled" },
    actorId: input.actorId,
  });
  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "job.cancelled",
    resourceKind: "job",
    resourceId: input.jobId,
    metadata: {},
  });
}
