import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { routes } from "@/lib/routes";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/supabase/env";

function isSupabaseAuthCookie(name: string) {
  return name.startsWith("sb-") && name.includes("-auth-token");
}

export async function POST(request: NextRequest) {
  const loginUrl = new URL(routes.login, request.url);
  const redirectResponse = NextResponse.redirect(loginUrl, { status: 303 });
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();

  const cleared = new Set<string>();

  if (url && key) {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            redirectResponse.cookies.set(name, value, options);
            cleared.add(name);
          });
        },
      },
    });

    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // A bad refresh token must still drop the browser session.
    }
  }

  for (const cookie of request.cookies.getAll()) {
    if (!isSupabaseAuthCookie(cookie.name) || cleared.has(cookie.name)) continue;
    redirectResponse.cookies.set(cookie.name, "", {
      path: "/",
      maxAge: 0,
      sameSite: "lax",
    });
  }

  return redirectResponse;
}
