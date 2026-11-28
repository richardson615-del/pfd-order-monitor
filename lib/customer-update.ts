import { looksLikeCardNumber } from "./phone-order";

/**
 * update_customer (ED3, 2026-11-28, prs-crm brief docs/briefs/2026-11-28-
 * edit-customer-details-on-orders.md): dispatch fixed the customer's name,
 * phone, drop-off address or delivery directions on an order the restaurant
 * already has. Forrest's dispatcher feedback: "edits made while an order is
 * live update only on the Zuppler side, so the partner can't see the change".
 *
 * The pure rules live here; the write and the fan-out in
 * lib/customer-update-server.ts.
 *
 * Any source (Zuppler, phone, Uber Eats, ezCater): the CRM is where the
 * correction is made, whoever took the order. Only a cancelled order is
 * refused. The kitchen is told (banner, UPDATED ticket, push) only for an
 * order still being worked on today - the OE2 rule, updateReprints().
 *
 * Directions are not a column of their own: the bridge has always kept them
 * in customer_address as "street | instructions" (the Zuppler mapper's
 * convention, which the ticket prints as a `>> ` line). So delivery_address
 * and delivery_notes are the two halves of that one column, and changing one
 * keeps the other.
 */
import { CUSTOMER_FIELDS, type CustomerField } from "./customer-change-banner";

export { CUSTOMER_FIELDS, customerChangeBanner, FIELD_WORDS, type CustomerField } from "./customer-change-banner";

const LIMITS: Record<CustomerField, number> = {
  customer_name: 120,
  customer_phone: 40,
  delivery_address: 360,
  delivery_notes: 500,
};

export interface CustomerUpdate {
  changed: CustomerField[];
  /** Only the changed fields; null = cleared (allowed for delivery_notes only). */
  values: Partial<Record<CustomerField, string | null>>;
}

export type CustomerUpdateParse = { ok: true; update: CustomerUpdate } | { ok: false; code: string; error: string };

const isField = (v: unknown): v is CustomerField => CUSTOMER_FIELDS.includes(v as CustomerField);

/**
 * The body: `changed_fields` (1-4 of CUSTOMER_FIELDS) says what changed, and
 * each listed field carries its new value. Fields the list does not name are
 * ignored even when sent, so the CRM may send all four as they are now.
 */
export function parseCustomerUpdate(body: unknown): CustomerUpdateParse {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const list = b.changed_fields;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, code: "changed_fields_required", error: `changed_fields must list at least one of: ${CUSTOMER_FIELDS.join(", ")}` };
  }
  const bad = list.find((f) => !isField(f));
  if (bad !== undefined) return { ok: false, code: "invalid_changed_fields", error: `changed_fields may only name: ${CUSTOMER_FIELDS.join(", ")}` };
  const changed = CUSTOMER_FIELDS.filter((f) => list.includes(f));

  const values: CustomerUpdate["values"] = {};
  for (const f of changed) {
    const raw = b[f];
    if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) {
      if (f !== "delivery_notes") return { ok: false, code: "invalid_field", error: `${f} is in changed_fields, so it needs a value` };
      values[f] = null;
      continue;
    }
    if (typeof raw !== "string") return { ok: false, code: "invalid_field", error: `${f} must be a string` };
    const v = raw.replace(/\s+/g, " ").trim();
    if (v.length > LIMITS[f]) return { ok: false, code: "invalid_field", error: `${f} is longer than ${LIMITS[f]} characters` };
    if (f === "delivery_address" && v.includes(" | ")) return { ok: false, code: "invalid_field", error: "delivery_address may not contain ' | ' (it separates the address from the directions)" };
    values[f] = v;
  }
  // Same rule as a phone order: a card number typed into a box never reaches a ticket.
  if (Object.values(values).some(looksLikeCardNumber)) {
    return { ok: false, code: "card_number_rejected", error: "a field contains what looks like a card number" };
  }
  return { ok: true, update: { changed, values } };
}

/** "street | instructions" -> its two halves. */
export function splitAddress(stored: string | null | undefined): { street: string | null; notes: string | null } {
  if (!stored) return { street: null, notes: null };
  const [street, ...rest] = String(stored).split(" | ");
  const notes = rest.join(" | ").trim();
  return { street: street.trim() || null, notes: notes || null };
}

export function joinAddress(street: string | null, notes: string | null): string | null {
  return [street, notes].filter((s) => s && s.trim()).join(" | ") || null;
}

/**
 * The order columns this update writes, given the row as it stands. Only
 * columns whose value really moves are returned; `changed` is the CRM's
 * field names whose value moved (a field listed but already equal is not a
 * change, so the kitchen is not told about nothing).
 */
export function customerColumns(
  row: { customer_name?: string | null; customer_phone?: string | null; customer_address?: string | null },
  update: CustomerUpdate
): { columns: Record<string, string | null>; changed: CustomerField[] } {
  const columns: Record<string, string | null> = {};
  const changed: CustomerField[] = [];
  const v = update.values;
  if ("customer_name" in v && (row.customer_name ?? null) !== v.customer_name) {
    columns.customer_name = v.customer_name ?? null;
    changed.push("customer_name");
  }
  if ("customer_phone" in v && (row.customer_phone ?? null) !== v.customer_phone) {
    columns.customer_phone = v.customer_phone ?? null;
    changed.push("customer_phone");
  }
  const cur = splitAddress(row.customer_address);
  const street = "delivery_address" in v ? v.delivery_address ?? null : cur.street;
  const notes = "delivery_notes" in v ? v.delivery_notes ?? null : cur.notes;
  if (street !== cur.street) changed.push("delivery_address");
  if (notes !== cur.notes) changed.push("delivery_notes");
  const nextAddress = joinAddress(street, notes);
  if (nextAddress !== (row.customer_address ?? null)) columns.customer_address = nextAddress;
  return { columns, changed };
}

/**
 * What the UPDATED ticket and the tablet push say changed. Short ASCII
 * lines, like OE2's summary. The new values print because the kitchen and
 * the driver at the pass need them, and the ticket already carries the
 * customer's phone and address; nothing here is logged.
 */
export function customerChangeSummary(update: CustomerUpdate, changed: CustomerField[]): string[] {
  const lines = ["CUSTOMER DETAILS CHANGED"];
  const v = update.values;
  for (const f of changed) {
    if (f === "customer_name") lines.push(`NAME: ${v.customer_name}`);
    if (f === "customer_phone") lines.push(`PHONE: ${v.customer_phone}`);
    if (f === "delivery_address") lines.push(`ADDRESS: ${v.delivery_address}`);
    if (f === "delivery_notes") lines.push(v.delivery_notes ? `DIRECTIONS: ${v.delivery_notes}` : "DIRECTIONS: (removed)");
  }
  return lines.slice(0, 12);
}

/**
 * A later Zuppler revision of the same order must not quietly put the old
 * customer details back after dispatch corrected them in the CRM (Zuppler is
 * changed by hand, and may never be). Once customer_changed_at is set, a
 * revision's name, phone and address are dropped; its money and items still land.
 */
export function keepCrmCustomerEdits(existing: { customer_changed_at?: string | null }, changes: Record<string, unknown>): Record<string, unknown> | null {
  if (!existing.customer_changed_at) return changes;
  const kept = { ...changes };
  delete kept.customer_name;
  delete kept.customer_phone;
  delete kept.customer_address;
  return Object.keys(kept).length ? kept : null;
}
