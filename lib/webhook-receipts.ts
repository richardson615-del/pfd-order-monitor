import { createHash } from "crypto";
import { supabaseAdmin } from "./supabase-server";

/**
 * Records what arrived at the order webhook, whatever became of it.
 *
 * The endpoint is open to the internet by necessity - Zuppler has to be able
 * to reach it - so two things matter here. The body is truncated, because an
 * unauthenticated caller must not be able to write unbounded rows. And this
 * never throws: recording a receipt is diagnostics, and diagnostics must not
 * be able to break the ingest path it is observing.
 */

/** Enough to identify a payload and see what was wrong with it. */
const MAX_BODY_CHARS = 2000;

export type ReceiptStatus =
  | "unauthorized"
  | "invalid_json"
  | "no_order_uuid"
  | "not_found"
  | "ingest_error"
  | "unmapped"
  | "created"
  | "duplicate"
  | "updated"
  | "cancelled";

/** Statuses that mean a real order made it into the system. */
export const ACCEPTED_STATUSES: ReceiptStatus[] = [
  "created",
  "duplicate",
  "updated",
  "cancelled",
];

/**
 * A short, non-reversible fingerprint of a credential.
 *
 * We have now chased the same "token mismatch" three times without being able
 * to tell WHICH side is stale, because neither value can be read: ours is
 * Secret-typed in Vercel, theirs lives in Zuppler's portal. Comparing
 * fingerprints settles it without either value being stored or displayed -
 * run the same hash over the portal token and see which one it matches.
 */
export function fingerprint(value: string | null | undefined): string | null {
  if (!value) return null;
  return `len${value.length}:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export interface ReceiptInput {
  status: ReceiptStatus;
  httpStatus?: number;
  orderUuid?: string | null;
  orderId?: string | null;
  detail?: string | null;
  rawBody?: string | null;
  userAgent?: string | null;
  source?: string;
}

export async function recordWebhookReceipt(input: ReceiptInput): Promise<void> {
  try {
    const admin = supabaseAdmin();
    const { error } = await admin.from("webhook_receipts").insert({
      source: input.source ?? "zuppler",
      status: input.status,
      http_status: input.httpStatus ?? null,
      order_uuid: input.orderUuid ?? null,
      order_id: input.orderId ?? null,
      detail: input.detail ? input.detail.slice(0, 500) : null,
      raw_body: input.rawBody ? input.rawBody.slice(0, MAX_BODY_CHARS) : null,
      user_agent: input.userAgent ? input.userAgent.slice(0, 200) : null,
    });
    if (error) {
      // Loud, because losing the record of a rejected receipt puts us back
      // where we started - unable to tell silence from refusal.
      console.error("webhook receipt not recorded", input.status, error.message);
    }
  } catch (err) {
    console.error(
      "webhook receipt not recorded",
      input.status,
      err instanceof Error ? err.message : err
    );
  }
}
