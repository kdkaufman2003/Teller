import {
  applyPartnerSetupDefaults,
  ensureHfacModule,
  partnerIdFromAnswers,
} from "@/lib/partners/attachment";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { defaultAnswers, resolveIndustry } from "@/lib/industries/registry";
import { createServiceClient } from "@/lib/supabase/admin";
import { generateTemporaryPassword } from "@/lib/platform/temp-password";
import type { ProfileRole } from "@/types";

export type CreatePlatformUserInput =
  | {
      mode: "existing_org";
      email: string;
      fullName: string;
      organizationId: string;
      role: ProfileRole;
    }
  | {
      mode: "new_org";
      email: string;
      fullName: string;
      companyName: string;
      legalName?: string;
      industryId: string;
    };

export type CreatePlatformUserResult = {
  userId: string;
  email: string;
  organizationId: string;
  temporaryPassword: string;
  emailDelivery: "recovery_sent" | "skipped";
};

function siteUrl(): string {
  const url = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "");
  return url || "http://localhost:3000";
}

export async function createPlatformUser(
  operatorUserId: string,
  input: CreatePlatformUserInput,
): Promise<CreatePlatformUserResult> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new Error("Valid email is required");
  }

  const fullName = input.fullName.trim();
  const temporaryPassword = generateTemporaryPassword();
  const admin = createServiceClient();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  });

  if (createError || !created.user) {
    const msg = createError?.message ?? "Could not create auth user";
    if (/already registered|already exists/i.test(msg)) {
      throw new Error("A user with this email already exists");
    }
    throw new Error(msg);
  }

  const userId = created.user.id;
  let organizationId: string;

  try {
    if (input.mode === "existing_org") {
      const { data, error } = await admin.rpc("teller_platform_attach_org_member", {
        p_user_id: userId,
        p_organization_id: input.organizationId,
        p_email: email,
        p_full_name: fullName,
        p_role: input.role,
      });
      if (error) throw new Error(error.message);
      organizationId = String((data as { organization_id?: string })?.organization_id ?? input.organizationId);
    } else {
      const answers = defaultAnswers(resolveIndustry(input.industryId, {}).pack);
      const partnerId = partnerIdFromAnswers(answers);
      const mergedAnswers = applyPartnerSetupDefaults(partnerId, answers);
      const resolved = resolveIndustry(input.industryId, mergedAnswers);
      const modules = ensureHfacModule(resolved.modules, partnerId);

      const { data, error } = await admin.rpc("teller_platform_complete_setup", {
        p_user_id: userId,
        p_email: email,
        p_full_name: fullName,
        p_name: input.companyName.trim(),
        p_legal_name: (input.legalName ?? "").trim(),
        p_industry_id: input.industryId,
        p_partner_id: partnerId,
        p_answers: mergedAnswers,
        p_modules: modules,
        p_labels: resolved.labels,
        p_accounts: resolved.accounts,
      });
      if (error) throw new Error(error.message);
      organizationId = String((data as { organization_id?: string })?.organization_id ?? "");
      if (!organizationId) throw new Error("Organization was not created");
    }
  } catch (err) {
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    throw err;
  }

  let emailDelivery: CreatePlatformUserResult["emailDelivery"] = "skipped";
  const { error: resetError } = await admin.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteUrl()}/login`,
  });
  if (!resetError) emailDelivery = "recovery_sent";

  await recordAuditEvent(admin, {
    organizationId,
    actorId: operatorUserId,
    action: input.mode === "new_org" ? "platform.org_provisioned" : "platform.user_created",
    resourceKind: "auth_user",
    resourceId: userId,
    metadata: {
      email,
      mode: input.mode,
      role: input.mode === "existing_org" ? input.role : "owner",
    },
  });

  return {
    userId,
    email,
    organizationId,
    temporaryPassword,
    emailDelivery,
  };
}
