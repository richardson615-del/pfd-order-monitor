import { supabaseAdmin } from "./supabase-server";

/**
 * Marks an order cancelled once, and says whether the kitchen should be told.
 *
 * Depot, 2026-11-20: order #340 was cancelled at 8:18 PM, an hour after the
 * kitchen had already finished it, and the "ORDER CANCELLED" ticket came out
 * twice. Two things were wrong:
 *  - every cancel path (the Zuppler webhook, the CRM's Cancel order, ezCater)
 *    emailed a notice each time it ran, so a cancel seen twice printed twice;
 *  - a notice went out for an order the kitchen had already completed, where
 *    "do not prepare it" means nothing and only confuses the line.
 *
 * The update is guarded on cancelled_at being empty, so only the first caller
 * wins even when two arrive together; printed_at and completed_at are never
 * touched (a ticket that printed and food that went out are facts).
 */
export type CancelNotice = "send" | "already_cancelled" | "already_completed";

export function cancelNoticeFor(first: boolean, completedAt: string | null | undefined): CancelNotice {
  if (!first) return "already_cancelled";
  if (completedAt) return "already_completed";
  return "send";
}

export async function markOrderCancelled(orderId: string, now: string): Promise<{ first: boolean; notice: CancelNotice; completedAt: string | null }> {
  const admin = supabaseAdmin();
  const { data } = await admin
    .from("orders")
    .update({ status: "cancelled", cancelled_at: now })
    .eq("id", orderId)
    .is("cancelled_at", null)
    .select("completed_at")
    .maybeSingle();
  const first = Boolean(data);
  const completedAt = (data as { completed_at?: string | null } | null)?.completed_at ?? null;
  return { first, notice: cancelNoticeFor(first, completedAt), completedAt };
}
