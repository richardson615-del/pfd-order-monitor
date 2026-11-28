/**
 * ED3 (2026-11-28): the tablet's half of update_customer - which fields the
 * CRM may change and when the yellow "Customer details changed" banner
 * shows. No imports, so the order screen can use it without pulling server
 * code into the browser. The write rules are in lib/customer-update.ts.
 */
export const CUSTOMER_FIELDS = ["customer_name", "customer_phone", "delivery_address", "delivery_notes"] as const;
export type CustomerField = (typeof CUSTOMER_FIELDS)[number];

const isField = (v: unknown): v is CustomerField => CUSTOMER_FIELDS.includes(v as CustomerField);

/** Plain words for the tablet banner: "address, directions". */
export const FIELD_WORDS: Record<CustomerField, string> = {
  customer_name: "name",
  customer_phone: "phone",
  delivery_address: "address",
  delivery_notes: "directions",
};

/**
 * Whether the yellow "Customer details changed" banner shows on the tablet:
 * the CRM changed them, the order is still open, and nobody at the
 * restaurant has tapped it since.
 * Reads the row only, so every screen at the restaurant agrees, and an old
 * row (or an older bridge without migration 069) never shows one.
 */
export function customerChangeBanner(
  o: { customer_changed_at?: string | null; customer_change_seen_at?: string | null; customer_changed_fields?: string[] | null; status?: string | null }
): { at: string; fields: string[] } | null {
  if (!o.customer_changed_at) return null;
  // A settled order is not being made or sent any more; there is nobody to warn.
  if (o.status === "cancelled" || o.status === "completed") return null;
  const at = Date.parse(o.customer_changed_at);
  if (Number.isNaN(at)) return null;
  const seen = o.customer_change_seen_at ? Date.parse(o.customer_change_seen_at) : NaN;
  if (!Number.isNaN(seen) && seen >= at) return null;
  const fields = (o.customer_changed_fields ?? []).filter(isField).map((f) => FIELD_WORDS[f]);
  return { at: o.customer_changed_at, fields };
}
