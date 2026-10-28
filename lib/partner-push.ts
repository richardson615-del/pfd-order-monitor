import { supabaseAdmin } from "./supabase-server";

/**
 * Push to every phone signed in to the restaurant's PFD Partner app (Expo push service).
 *
 * Two senders: a dispatcher's reply (app/api/crm/messages, data.screen "messages") and,
 * since 2026-10-28, every new order (lib/canonical deliverToApp, data.screen "orders"), so
 * an owner's phone rings for an order even where the restaurant has no tablet or printer.
 *
 * Never throws: a push failing must never fail the order or the reply that caused it.
 * Phones Expo reports as gone are forgotten. `phones` is how many were signed in.
 */
export async function pushToRestaurantApps(
  restaurantId: string,
  msg: { title: string; body: string; data?: Record<string, unknown> }
): Promise<{ phones: number; sent: number }> {
  try {
    const { data: rows } = await supabaseAdmin().from("app_push_tokens").select("token").eq("restaurant_id", restaurantId);
    const tokens = (rows ?? []).map((r) => r.token as string);
    if (!tokens.length) return { phones: 0, sent: 0 };
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        tokens.map((to) => ({ to, title: msg.title, body: msg.body.slice(0, 180), data: msg.data ?? {}, sound: "default", priority: "high" }))
      ),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("partner app: push failed", res.status);
      return { phones: tokens.length, sent: 0 };
    }
    const json = (await res.json().catch(() => null)) as { data?: Array<{ status?: string; details?: { error?: string } }> } | null;
    let sent = 0;
    for (const [i, t] of (json?.data ?? []).entries()) {
      if (t.status === "ok") sent++;
      else if (t.details?.error === "DeviceNotRegistered" && tokens[i]) {
        await supabaseAdmin().from("app_push_tokens").delete().eq("token", tokens[i]!);
      }
    }
    return { phones: tokens.length, sent };
  } catch (err) {
    console.error("partner app: push error", err instanceof Error ? err.message : err);
    return { phones: 0, sent: 0 };
  }
}
