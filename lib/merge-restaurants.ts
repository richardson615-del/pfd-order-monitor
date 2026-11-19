/**
 * Merge a duplicate restaurant into the real one (Matt 2026-11-19, El Vaquero:
 * Zuppler orders and the printer on one restaurant, CRM phone orders on the
 * other, so phone orders never printed).
 *
 * The work is one Postgres function, merge_restaurants (migration 064), so it
 * happens in one transaction. This file is the request rules and the mapping
 * of the function's errors to the codes the CRM shows; the route supplies the
 * database call, so the rules are tested without one.
 */

export interface MergeInput {
  /** Either id (the bridge's uuid or the CRM account id) of the restaurant to keep. */
  into: string;
  /** Give the kept restaurant the duplicate's CRM account link (the real account was on the duplicate). */
  take_crm: boolean;
  actor: string | null;
}

export type MergeParse = { ok: true; input: MergeInput } | { ok: false; code: string; error: string };

const REF = /^[A-Za-z0-9._:-]{1,128}$/;

export function parseMergeBody(body: unknown): MergeParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "invalid_body", error: "a JSON body is required" };
  const b = body as Record<string, unknown>;
  const into = typeof b.into === "string" ? b.into.trim() : "";
  if (!REF.test(into)) return { ok: false, code: "invalid_into", error: "into must name the restaurant to keep (its id or CRM account id)" };
  if (b.take_crm !== undefined && typeof b.take_crm !== "boolean") return { ok: false, code: "invalid_take_crm", error: "take_crm must be true or false" };
  const actor = typeof b.actor === "string" && b.actor.trim() ? b.actor.trim().slice(0, 120) : null;
  return { ok: true, input: { into, take_crm: b.take_crm === true, actor } };
}

/** The function raises these by name; anything else is a 500. */
const KNOWN: Record<string, { status: 400 | 404 | 409; error: string }> = {
  merge_same_restaurant: { status: 400, error: "That is the same restaurant." },
  restaurant_not_found: { status: 404, error: "One of the two restaurants doesn't exist." },
  into_inactive: { status: 409, error: "The restaurant to keep is switched off. Pick an active one." },
  statement_conflict: { status: 409, error: "Both restaurants have a statement for the same period. Sort the statements out first; a merge never overwrites one." },
};

export function mergeErrorFor(message: string | null | undefined): { status: 400 | 404 | 409 | 500; code: string; error: string } {
  const m = (message ?? "").trim();
  const hit = KNOWN[m];
  return hit ? { status: hit.status, code: m, error: hit.error } : { status: 500, code: "merge_failed", error: m || "merge failed" };
}
