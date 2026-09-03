import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { routes } from "@/lib/routes";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/supabase/env";

function isStaleAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: string; message?: string };
  const message = (err.message || "").toLowerCase();
  return (
    err.code === "refresh_token_not_found" ||
    err.code === "invalid_refresh_token" ||
    message.includes("refresh token") ||
    message.includes("invalid jwt")
  );
}

function isPublicPath(pathname: string): boolean {
  if (pathname === routes.home) return true;
  if (pathname === routes.login || pathname === routes.signup) return true;
  if (pathname === routes.callback || pathname.startsWith("/auth/")) return true;
  if (pathname.startsWith("/api/integrations/quoter/quotes")) return true;
  return false;
}

function requiresAuth(pathname: string): boolean {
  return (
    pathname === routes.setup ||
    pathname === routes.app ||
    pathname.startsWith("/app/")
  );
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  const { pathname, search } = request.nextUrl;

  if (!url || !key) {
    return supabaseResponse;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  let user = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      if (isStaleAuthError(error)) await supabase.auth.signOut();
    } else {
      user = data.user;
    }
  } catch (error) {
    if (isStaleAuthError(error)) {
      try {
        await supabase.auth.signOut();
      } catch {
        /* ignore */
      }
    }
  }

  if (pathname.startsWith("/api/")) {
    return supabaseResponse;
  }

  if (!user && requiresAuth(pathname) && !isPublicPath(pathname)) {
    const login = request.nextUrl.clone();
    login.pathname = routes.login;
    login.search = "";
    login.searchParams.set("next", `${pathname}${search || ""}`);
    return NextResponse.redirect(login);
  }

  if (user && (pathname === routes.login || pathname === routes.signup)) {
    const dest = request.nextUrl.clone();
    dest.pathname = routes.app;
    dest.search = "";
    return NextResponse.redirect(dest);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|js|css|json|ico)$).*)",
  ],
};
