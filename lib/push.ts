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

export interface PushResult {
  /** Subscriptions registered for the restaurant at the time of sending. */
  subscriptions: number;
  /** Pushes the browser vendor accepted. */
  sent: number;
  /** Pushes that failed for a reason other than a dead subscription. */
  failed: number;
  /** Set when the send could not be attempted at all. */
  error?: string;
}

/**
 * Sends a push notification to every device registered for a restaurant.
 *
 * Never throws. It used to, and the consequence was out of all proportion to
 * the cause: setVapidDetails() rejects a missing or malformed key, and that
 * exception escaped ingestOrder() *after* the order row was written but
 * *before* the ticket was queued. The webhook then 500'd, Zuppler retried,
 * de-duplication found the existing order and returned early -- so the retry
 * that should have healed it guaranteed the ticket was never printed at all.
 * A misconfigured notification key could silently stop a kitchen printing.
 *
 * The outcome is returned instead, so the caller can record it against the
 * order rather than discover it in a stack trace.
 */
export async function notifyRestaurant(
  restaurantId: string,
  payload: { title: string; body: string; orderId: string }
): Promise<PushResult> {
  const empty: PushResult = { subscriptions: 0, sent: 0, failed: 0 };
  const admin = supabaseAdmin();

  try {
    ensureConfigured();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("push: cannot send, VAPID configuration is unusable -", error);
    return { ...empty, error };
  }

  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("*")
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: false });

  if (error) return { ...empty, error: error.message };
  if (!subs?.length) return empty;

  let sent = 0;
  let failed = 0;

  // A restaurant with hundreds of subscriptions is not a restaurant with
  // hundreds of tablets - it is stale endpoints from reinstalls that have
  // not yet 410'd. The newest are the live ones; the rest get a turn on the
  // next order, and the dead ones prune themselves as they fail.
  const targets = subs.slice(0, MAX_SUBSCRIPTIONS_PER_RESTAURANT);

  await mapWithConcurrency(targets, PUSH_CONCURRENCY, async (sub) => {
    {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify(payload)
        );
        sent++;
      } catch (err: any) {
        // 410/404 means the subscription is dead (browser uninstalled, etc.) - clean it up.
        // Not counted as a failure: nothing is wrong, that device is simply gone.
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          await admin.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          failed++;
          console.error(
            "push: send failed",
            err?.statusCode ?? "",
            err instanceof Error ? err.message : err
          );
        }
      }
    }
  });

  return { subscriptions: subs.length, sent, failed };
}

/** How many pushes are in flight at once. Web push endpoints rate-limit; a burst of five hundred is how they say no. */
export const PUSH_CONCURRENCY = 20;
/** Newest-first cap per restaurant, see notifyRestaurant. */
export const MAX_SUBSCRIPTIONS_PER_RESTAURANT = 50;

export async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
}
