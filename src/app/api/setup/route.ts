import { NextResponse } from "next/server";
import {
  applyPartnerSetupDefaults,
  attachPartner,
  detachPartner,
  ensureQuoterModule,
  partnerIdFromAnswers,
} from "@/lib/partners/attachment";
import { resolveIndustry } from "@/lib/industries/registry";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    name?: string;
    legalName?: string;
    industryId?: string;
    partnerId?: string | null;
    deploymentMode?: "standalone" | "attached";
    answers?: Record<string, unknown>;
  };

  const name = String(body.name || "").trim();
  const industryId = String(body.industryId || "").trim();
  if (!name) {
    return NextResponse.json({ error: "Company name is required" }, { status: 400 });
  }
  if (!industryId) {
    return NextResponse.json({ error: "Choose an industry" }, { status: 400 });
  }

  const answers = {
    ...(body.answers || {}),
    deploymentMode: body.deploymentMode || body.answers?.deploymentMode || "standalone",
  };
  const partnerId =
    body.partnerId === "hasslefreeac"
      ? "hasslefreeac"
      : partnerIdFromAnswers(answers);
  const mergedAnswers = applyPartnerSetupDefaults(partnerId, answers);
  const resolved = resolveIndustry(industryId, mergedAnswers);
  const modules = ensureQuoterModule(resolved.modules, partnerId);

  const { data, error } = await supabase.rpc("teller_complete_setup", {
    p_name: name,
    p_legal_name: String(body.legalName || "").trim(),
    p_industry_id: industryId,
    p_partner_id: partnerId,
    p_answers: mergedAnswers,
    p_modules: modules,
    p_labels: resolved.labels,
    p_accounts: resolved.accounts,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, result: data, partnerId });
}
