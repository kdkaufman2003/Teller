import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { PRESENTATION_MODE_COOKIE } from "@/lib/ux/presentation-mode";
import type { PresentationMode } from "@/lib/accounting/presentation-mode";

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as { mode?: PresentationMode };
  if (body.mode !== "owner" && body.mode !== "accountant") {
    return jsonError("mode must be owner or accountant", 400);
  }

  const response = NextResponse.json({ mode: body.mode });
  response.cookies.set(PRESENTATION_MODE_COOKIE, body.mode, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
