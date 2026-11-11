import { supabaseAdmin } from "./supabase-server";
import { moneyVariance, orderUpdateFields } from "./canonical";
import { orderChangeSummary, updateReprints, DEFAULT_ORDERS_TZ } from "./crm-orders";
import { parsePhoneOrder, phoneOrderFingerprint, phoneOrderToCanonical } from "./phone-order";
import { resendOrder, type ResendChannelResult } from "./order-resend";

/**
 * update (OE2, prs-crm QUEUE row 313, brief prs-crm docs/briefs/2026-11-10-
 * edit-orders-tender-items-tip.md): the CRM changed a phone order after it
 * was sent - items, tip, payment. The body carries the WHOLE order again, in
 * the same shape POST /api/crm/orders takes, so there is one way to describe
 * a phone order. The stored row takes the changed columns (orderUpdateFields,
 * the same diff a Zuppler revision uses), money_variance is recomputed, and
 * raw_payload keeps the new order with a `last_update` note (who, why, when,
 * what changed). A kitchen still working on the order today gets an UPDATED
 * ticket everywhere it receives orders (printer, PC inbox, tablet); a
 * completed or older order changes its money quietly.
 */
export interface UpdateOutcome {
  ok: true;
  changed: string[];
  summary: string[];
  reprinted: boolean;
  channels: ResendChannelResult[];
}

export type UpdateFailure = { ok: false; status: number; code: string; error: string };

export async function updatePhoneOrderForCrm(
  order: Record<string, any>,
  body: { order?: unknown; reason?: unknown; actor: string; tz?: string },
  now: number = Date.now()
): Promise<UpdateOutcome | UpdateFailure> {
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason) return { ok: false, status: 400, code: "reason_required", error: "say why the order changed (reason)" };
  const parsed = parsePhoneOrder(body.order);
  if (!parsed.ok) return { ok: false, status: 400, code: parsed.code, error: parsed.error };
  const next = parsed.order;
  const admin = supabaseAdmin();
  const { data: full } = await admin.from("orders").select("*").eq("id", order.id).maybeSingle();
  if (!full) return { ok: false, status: 404, code: "order_not_found", error: "order not found" };
  if (next.source !== "phone" || full.source !== "phone" || next.external_id !== full.external_id) {
    return { ok: false, status: 409, code: "order_mismatch", error: "the updated order is not this order (source and external_id must match)" };
  }

  const fingerprint = phoneOrderFingerprint(next);
  const canonical = phoneOrderToCanonical(next, { id: full.restaurant_id, name: full.ticket_restaurant_name ?? null }, { fingerprint, receivedAt: full.received_at ?? undefined });
  const nextCols = {
    order_type: canonical.orderType ?? null,
    due_time: canonical.dueTime ?? null,
    customer_name: canonical.customerName ?? null,
    customer_phone: canonical.customerPhone ?? null,
    customer_address: canonical.customerAddress ?? null,
    items: canonical.items,
    items_total: canonical.itemsTotal ?? null,
    tax: canonical.tax ?? null,
    service_fee: canonical.serviceFee ?? null,
    delivery_fee: canonical.deliveryFee ?? null,
    tip: canonical.tip ?? null,
    discount: canonical.discount ?? null,
    surcharge: canonical.surcharge ?? null,
    customer_total: canonical.customerTotal ?? null,
    payment_type: canonical.paymentType ?? null,
    notes: canonical.notes ?? null,
  };
  const changes = orderUpdateFields(full, nextCols) ?? {};
  // orderUpdateFields never writes an empty value (a sparse Zuppler re-delivery must not erase
  // data). For an order the CRM owns, a fee, tip or note that went to nothing is a real change.
  for (const k of ["service_fee", "delivery_fee", "discount", "surcharge"] as const) {
    if (!Number(nextCols[k] ?? 0) && Number(full[k] ?? 0)) changes[k] = null;
  }
  if (!Number(nextCols.tip ?? 0) && Number(full.tip ?? 0)) changes.tip = 0;
  if (!nextCols.notes && full.notes) changes.notes = null;
  if (!Object.keys(changes).length) return { ok: true, changed: [], summary: [], reprinted: false, channels: [] };

  const after = { ...full, ...changes };
  const summary = orderChangeSummary(full, after);
  const at = new Date(now).toISOString();
  const previous = (full.raw_payload && typeof full.raw_payload === "object" ? full.raw_payload : {}) as Record<string, any>;
  const revision = Number(previous.last_update?.revision ?? 0) + 1;
  const rawPayload = {
    ...(canonical.rawPayload as Record<string, unknown>),
    last_update: { revision, at, by: body.actor, reason, changed: Object.keys(changes), summary },
  };

  const { error } = await admin
    .from("orders")
    .update({ ...changes, money_variance: moneyVariance(canonical), raw_payload: rawPayload })
    .eq("id", full.id);
  if (error) return { ok: false, status: 500, code: "update_failed", error: error.message };
  console.log("CRM order updated", JSON.stringify({ order: full.id, by: body.actor, revision, changed: Object.keys(changes) }));

  if (!updateReprints(full, now, body.tz ?? DEFAULT_ORDERS_TZ)) {
    return { ok: true, changed: Object.keys(changes), summary, reprinted: false, channels: [] };
  }
  const sent = await resendOrder(after, body.actor, { kind: "update", summary });
  return { ok: true, changed: Object.keys(changes), summary, reprinted: sent.channels.some((c) => c.ok && c.channel === "printer"), channels: sent.channels };
}
