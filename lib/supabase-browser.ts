import { createBrowserClient } from "@supabase/ssr";
import { reconnectDelayMs } from "./kiosk";

// Use this in Client Components ("use client" files) ONLY.
// Never import next/headers or the service role key into this file -
// it gets bundled into the browser.
export function supabaseBrowser() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    realtime: {
      params: { eventsPerSecond: 5 },
      // The library's default schedule is the same fixed steps on every
      // client, so after an outage five hundred tablets reconnect in the
      // same second. Exponential with full jitter spreads them across a
      // minute. See reconnectDelayMs.
      reconnectAfterMs: (tries: number) => reconnectDelayMs(tries),
    },
  });
}
