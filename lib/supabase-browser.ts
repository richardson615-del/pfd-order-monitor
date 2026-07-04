import { createBrowserClient } from "@supabase/ssr";

// Use this in Client Components ("use client" files) ONLY.
// Never import next/headers or the service role key into this file -
// it gets bundled into the browser.
export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
