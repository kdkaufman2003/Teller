#!/usr/bin/env node
/**
 * Grant platform operator access (run locally with service role).
 *
 *   node scripts/bootstrap-platform-admin.mjs you@hf.tech
 */
import { createClient } from "@supabase/supabase-js";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: node scripts/bootstrap-platform-admin.mjs <operator-email>");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: list, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listError) {
  console.error(listError.message);
  process.exit(1);
}

const user = list.users.find((u) => u.email?.toLowerCase() === email);
if (!user) {
  console.error(`No auth user for ${email}. Have them sign up once, then rerun.`);
  process.exit(1);
}

const { error } = await admin.from("teller_platform_admins").upsert(
  { user_id: user.id, note: "bootstrap script" },
  { onConflict: "user_id" },
);

if (error) {
  console.error(error.message);
  console.error("Apply migration 048_platform_admin.sql first.");
  process.exit(1);
}

console.log(`Platform admin granted for ${email} (${user.id})`);
