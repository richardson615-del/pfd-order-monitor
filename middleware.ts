import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Two jobs, in order: keep the customer-facing host to customer-facing pages,
 * then the existing session check.
 */

/** Paths that require a signed-in user. Was the matcher; now checked in code,
 *  because the host gate below needs to see every request and the auth check
 *  must NOT start running on all of them. */
function isProtected(path: string): boolean {
  return (
    path.startsWith("/dashboard") ||
    path.startsWith("/admin") ||
    path.startsWith("/order/") ||
    path.startsWith("/api/admin/") ||
    path.startsWith("/api/orders/") ||
    path.startsWith("/api/push/") ||
    path === "/api/gmail/connect"
  );
}

/** The host printed on receipts, if one is configured. */
function publicHost(): string | null {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return null;
  try {
    return new URL(base).host.toLowerCase();
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // --- host gate ------------------------------------------------------------
  // The receipt domain serves ONE thing. Adding a domain in Vercel otherwise
  // serves the whole app on it, so a customer who trims the URL off their
  // receipt would find the admin login - an invitation nobody meant to print.
  //
  // Cheap and first: no database work happens for a request that is about to
  // be redirected, and none of this runs at all when PUBLIC_BASE_URL is unset.
  const configured = publicHost();
  if (configured) {
    const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0];
    if (host === configured.split(":")[0] && !path.startsWith("/f/")) {
      const away = process.env.PUBLIC_REDIRECT_URL || "https://pfdworks.com";
      return NextResponse.redirect(away, 307);
    }
  }

  if (!isProtected(path)) {
    return NextResponse.next({ request: { headers: request.headers } });
  }

  // --- session check (unchanged) --------------------------------------------
  let response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: any) {
          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: any) {
          response.cookies.set({ name, value: "", ...options });
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isApiPath = path.startsWith("/api/");
  const protectedPagePath =
    path.startsWith("/dashboard") || path.startsWith("/admin") || path.startsWith("/order/");

  if (!user && protectedPagePath && !isApiPath) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Everything except build assets. The host gate has to see requests the old
  // matcher never did - that is the whole point - and isProtected() above
  // keeps the auth check on exactly the paths it covered before.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.json).*)"],
};
