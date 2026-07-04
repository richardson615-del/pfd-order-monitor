import webpush from "web-push";
import { supabaseAdmin } from "./supabase-server";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_CONTACT_EMAIL || "support@pfdworks.com"}`,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
  configured = true;
}

/** Sends a push notification to every device registered for a restaurant. */
export async function notifyRestaurant(
  restaurantId: string,
  payload: { title: string; body: string; orderId: string }
) {
  ensureConfigured();
  const admin = supabaseAdmin();
  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("*")
    .eq("restaurant_id", restaurantId);

  if (error || !subs?.length) return;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify(payload)
        );
      } catch (err: any) {
        // 410/404 means the subscription is dead (browser uninstalled, etc.) - clean it up
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          await admin.from("push_subscriptions").delete().eq("id", sub.id);
        }
      }
    })
  );
}
