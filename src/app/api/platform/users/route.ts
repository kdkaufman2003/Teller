import { NextResponse } from "next/server";
import {
  createPlatformUser,
  type CreatePlatformUserInput,
} from "@/lib/platform/provision-user";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { hasServiceRole } from "@/lib/supabase/admin";
import type { ProfileRole } from "@/types";

const ROLES: ProfileRole[] = ["owner", "admin", "bookkeeper", "viewer"];

export async function POST(request: Request) {
  const ctx = await requirePlatformAdmin();
  if ("error" in ctx && ctx.error) return ctx.error;
  if (!hasServiceRole()) {
    return NextResponse.json({ error: "Service role not configured" }, { status: 503 });
  }

  const body = (await request.json()) as Record<string, unknown>;
  const mode = body.mode === "new_org" ? "new_org" : body.mode === "existing_org" ? "existing_org" : null;
  const email = String(body.email ?? "").trim();
  const fullName = String(body.fullName ?? "").trim();

  if (!mode) {
    return NextResponse.json({ error: "mode must be existing_org or new_org" }, { status: 400 });
  }
  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  let input: CreatePlatformUserInput;
  if (mode === "existing_org") {
    const organizationId = String(body.organizationId ?? "").trim();
    const role = String(body.role ?? "viewer") as ProfileRole;
    if (!organizationId) {
      return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
    }
    if (!ROLES.includes(role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    input = { mode, email, fullName, organizationId, role };
  } else {
    const companyName = String(body.companyName ?? "").trim();
    const industryId = String(body.industryId ?? "").trim();
    if (!companyName) {
      return NextResponse.json({ error: "companyName is required" }, { status: 400 });
    }
    if (!industryId) {
      return NextResponse.json({ error: "industryId is required" }, { status: 400 });
    }
    input = {
      mode,
      email,
      fullName,
      companyName,
      legalName: String(body.legalName ?? "").trim(),
      industryId,
    };
  }

  try {
    const result = await createPlatformUser(ctx.session.userId, input);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create user";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
