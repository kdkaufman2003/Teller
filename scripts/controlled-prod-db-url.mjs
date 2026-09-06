/** Parse Supabase Postgres connection strings — never log the URL itself. */
export const PRODUCTION_REF = "ypixbxicdecwfafculha";

export function parseSupabaseDbProjectRef(dbUrl) {
  const trimmed = dbUrl?.trim();
  if (!trimmed) return null;

  let match = trimmed.match(/\/\/postgres\.([a-z0-9]+):/i);
  if (match) return match[1].toLowerCase();

  match = trimmed.match(/@db\.([a-z0-9]+)\.supabase\.co/i);
  if (match) return match[1].toLowerCase();

  try {
    const host = new URL(trimmed.replace(/^postgresql:/i, "http:")).hostname.toLowerCase();
    match = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
    if (match) return match[1];
  } catch {
    // ignore malformed URLs
  }

  return null;
}

export function assertProductionDbUrl(dbUrl, expectedRef = PRODUCTION_REF) {
  const trimmed = dbUrl?.trim();
  if (!trimmed) {
    throw new Error("Missing SUPABASE_DB_URL in .env.controlled-prod.local");
  }

  const ref = parseSupabaseDbProjectRef(trimmed);
  if (ref !== expectedRef) {
    throw new Error(
      `SUPABASE_DB_URL must target production ref ${expectedRef}, got ${ref ?? "unrecognized host"}`,
    );
  }

  return ref;
}
