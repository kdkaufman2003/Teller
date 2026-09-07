import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  createAccountingSchedule,
  type CreateScheduleInput,
} from "@/lib/accounting/schedules/schedule-crud";
import type { ScheduleType } from "@/lib/accounting/schedules/types";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const scheduleType = url.searchParams.get("type");

  let query = ctx.supabase
    .from("teller_accounting_schedules")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .order("updated_at", { ascending: false });

  if (scheduleType) query = query.eq("schedule_type", scheduleType);

  const { data, error } = await query;
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ schedules: [], schemaReady: false });
    }
    return jsonError(error.message, 500);
  }

  return NextResponse.json({ schedules: data ?? [], schemaReady: true });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as Partial<CreateScheduleInput> & { scheduleType?: ScheduleType };
  if (!body.scheduleType || !body.name || !body.startDate || body.originalAmount == null) {
    return jsonError("scheduleType, name, startDate, and originalAmount are required", 400);
  }

  try {
    const schedule = await createAccountingSchedule(ctx.supabase, {
      organizationId: ctx.organizationId,
      scheduleType: body.scheduleType,
      name: body.name,
      reference: body.reference,
      memo: body.memo,
      vendorPartyId: body.vendorPartyId,
      sourceDocumentId: body.sourceDocumentId,
      sourcePaymentId: body.sourcePaymentId,
      startDate: body.startDate,
      endDate: body.endDate,
      originalAmount: Number(body.originalAmount),
      expenseAccountId: body.expenseAccountId,
      prepaidAccountId: body.prepaidAccountId,
      liabilityAccountId: body.liabilityAccountId,
      revenueAccountId: body.revenueAccountId,
      frequency: body.frequency,
      recognitionMethod: body.recognitionMethod,
      autoReverse: body.autoReverse,
      reversalTiming: body.reversalTiming,
      jobId: body.jobId,
      depositAvailable: body.depositAvailable != null ? Number(body.depositAvailable) : null,
      depositApplied: body.depositApplied != null ? Number(body.depositApplied) : null,
      actorId: ctx.session.userId,
    });
    return NextResponse.json({ schedule });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not create schedule", 400);
  }
}
