import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseAnonKey, getSupabaseUrl, isSupabaseConfigured } from "./env";

export function createClient() {
  return createBrowserClient(getSupabaseUrl()!, getSupabaseAnonKey()!);
}

export { isSupabaseConfigured };
