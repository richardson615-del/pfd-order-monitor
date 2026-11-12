/**
 * The number people see for an order (059, Matt 2026-11-11: "a numerical number in order like we did before with
 * data dreamers"). From 2026-11-12 every order gets ticket_no, 1, 2, 3 per restaurant; older orders and TEST-
 * orders have none and keep showing order_number, the source's own reference.
 */
export function displayOrderNo(o: { ticket_no?: number | null; order_number?: string | null }): string {
  if (typeof o.ticket_no === "number") return String(o.ticket_no);
  return o.order_number?.trim() || "?";
}

/** The source's reference, printed small under the plain number; null when it would only repeat it. */
export function orderSourceRef(o: { ticket_no?: number | null; order_number?: string | null }): string | null {
  if (typeof o.ticket_no !== "number") return null;
  const ref = o.order_number?.trim();
  return ref && ref !== String(o.ticket_no) ? ref : null;
}

/**
 * For the kitchen's own API (the tablet and the PFD Partner app): order_number becomes the plain number and the
 * source's reference moves to source_ref. Builds already installed read order_number, so they show 1, 2, 3 with
 * no app release. Only for screens: anything that matches orders keeps reading the table's order_number.
 */
export function withDisplayOrderNo<T extends { ticket_no?: number | null; order_number?: string | null }>(rows: T[]): Array<T & { source_ref: string | null }> {
  return rows.map((r) => ({ ...r, order_number: displayOrderNo(r), source_ref: r.order_number ?? null }));
}
