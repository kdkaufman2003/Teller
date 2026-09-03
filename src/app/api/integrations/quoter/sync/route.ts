import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";

/** Bulk DB sync removed — Teller and Hassle Free AC use separate Supabase projects. */
export async function POST() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  return jsonError(
    "Bulk sync is not available. Hassle Free AC sends won deals to Teller via webhook. " +
      "Configure TELLER_WEBHOOK_URL on the Hassle Free AC deployment.",
    400,
  );
}
