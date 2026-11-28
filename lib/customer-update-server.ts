import { supabaseAdmin } from "./supabase-server";
import { DEFAULT_ORDERS_TZ, updateReprints } from "./crm-orders";
import { resendOrder, type ResendChannelResult } from "./order-resend";
import { customerChangeSummary, customerColumns, type CustomerField, type CustomerUpdate } from "./customer-update";

/**
 * update_customer (ED3): write the corrected customer details onto the order
 * and, for an order the kitchen is still working on today, tell the
 * restaurant - the banner (customer_changed_at, migration 069), an UPDATED
 * ticket on its printers / PC inbox and the tablet push, through the same
 * fan-out OE2's update uses (resendOrder kind "update"). The printer reads
 * what changed from raw_payload.last_update.summary, as for OE2.
 *
 * Nothing about money moves. The phone number is never logged.
 */
export interface CustomerUpdateOutcome {
  ok: true;
  changed: CustomerField[];
  notified: boolean;
  reprinted: boolean;
  channels: ResendChannelResult[];
}
export type CustomerUpdateFailure = { ok: false; status: number; code: string; error: string };

export async function updateCustomerForCrm(
  orderId: string,
  update: CustomerUpdate,
  opts: { actor: string; tz?: string },
  now: number = Date.now()
): Promise<CustomerUpdateOutcome | CustomerUpdateFailure> {
  const admin = supabaseAdmin();
  const { data: full } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!full) return { ok: false, status: 404, code: "order_not_found", error: "order not found" };
  if (full.status === "cancelled") return { ok: false, status: 409, code: "order_cancelled", error: "this order is cancelled; its customer details can't be changed" };
  if (full.order_type !== "delivery" && update.changed.some((f) => f === "delivery_address")) {
    // A pickup order has no drop-off; the CRM changing one means it has the wrong order.
    return { ok: false, status: 409, code: "not_delivery", error: "this is a pickup order; it has no delivery address" };
  }

  const { columns, changed } = customerColumns(full, update);
  if (!changed.length) return { ok: true, changed: [], notified: false, reprinted: false, channels: [] };

  const at = new Date(now).toISOString();
  const summary = customerChangeSummary(update, changed);
  const previous = (full.raw_payload && typeof full.raw_payload === "object" ? full.raw_payload : {}) as Record<string, any>;
  const revision = Number(previous.last_update?.revision ?? 0) + 1;
  const rawPayload = {
    ...previous,
    last_update: { revision, at, by: opts.actor, kind: "customer", reason: "customer details changed", changed, summary },
  };

  const { error } = await admin
    .from("orders")
    .update({
      ...columns,
      customer_changed_at: at,
      customer_changed_fields: changed,
      customer_change_seen_at: null,
      raw_payload: rawPayload,
    })
    .eq("id", full.id);
  if (error) return { ok: false, status: 500, code: "update_failed", error: error.message };
  // Field names only - never the values (no customer phone in logs).
  console.log("CRM customer details updated", JSON.stringify({ order: full.id, by: opts.actor, revision, changed }));

  if (!updateReprints(full, now, opts.tz ?? DEFAULT_ORDERS_TZ)) {
    return { ok: true, changed, notified: false, reprinted: false, channels: [] };
  }
  const after = { ...full, ...columns, raw_payload: rawPayload };
  const sent = await resendOrder(after, opts.actor, { kind: "update", summary });
  return {
    ok: true,
    changed,
    notified: true,
    reprinted: sent.channels.some((c) => c.ok && c.channel === "printer"),
    channels: sent.channels,
  };
}
