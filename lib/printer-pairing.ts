/**
 * Pairing an Eatabit printer to a restaurant from a code on its screen.
 *
 * A printer on WiFi with no device key asks for a six-digit code and shows
 * it. The office types the code against a restaurant (admin panel, or the
 * CRM through /api/crm/printers/pair); that registers the printer and parks
 * its key on the code row. The printer collects the key once, on its next
 * poll, and starts printing. The key is never shown to anybody.
 *
 * The code rules are the tablet's (lib/link-code.ts) - six digits, thirty
 * minutes, bound to the device that asked, rate-limited per address. This
 * file holds what differs: the table, what "linked" carries, and the one
 * piece both office routes share.
 */
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { markPrinterExpected } from "@/lib/restaurant-resolve";
import { isLinkCode, linkCodeState } from "@/lib/link-code";

export const PAIR_TABLE = "printer_link_codes";

/** Human-typeable key: PFD-XXXX-XXXX-XXXX, no ambiguous characters. */
export function newDeviceKey(bytes: (n: number) => Uint8Array = (n) => Uint8Array.from(randomBytes(n))): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const chunk = () => Array.from(bytes(4)).map((b) => alphabet[b % alphabet.length]).join("");
  return `PFD-${chunk()}-${chunk()}-${chunk()}`;
}

export interface PairRow {
  code: string;
  device_id: string;
  expires_at: string;
  restaurant_id: string | null;
  linked_at: string | null;
  device_key: string | null;
  consumed_at: string | null;
}

/** Whether `device` may collect the key on `row` right now. */
export function mayCollectKey(row: PairRow, device: string, now: number): boolean {
  if (row.device_id !== device) return false;
  if (linkCodeState(row, now) !== "linked") return false;
  return typeof row.device_key === "string" && row.device_key.length > 0;
}

/** A printer name the office did not type: "Printer 123456". */
export const defaultPrinterName = (code: string) => `Printer ${code}`;

export type PairResult =
  | { ok: true; restaurant: { id: string; name: string }; device: { id: string; name: string } }
  | { ok: false; status: number; code: string; error: string };

/**
 * The office half. Registers a print device for the restaurant and parks its
 * key on the still-pending code row. If somebody else paired the code a
 * moment earlier the new device is removed again, so a race leaves one
 * printer row, not two.
 */
export async function pairPrinter(
  rawCode: unknown,
  restaurant: { id: string; name: string },
  name: string | null,
  actor: string | null
): Promise<PairResult> {
  const code = typeof rawCode === "string" ? rawCode.replace(/\s+/g, "") : "";
  if (!isLinkCode(code)) return { ok: false, status: 400, code: "bad_code", error: "The code is six digits." };

  const admin = supabaseAdmin();
  const now = Date.now();
  const { data: row } = await admin
    .from(PAIR_TABLE)
    .select("code, device_id, expires_at, restaurant_id, linked_at, device_key, consumed_at")
    .eq("code", code)
    .maybeSingle();
  if (!row) return { ok: false, status: 404, code: "code_not_found", error: "No printer is showing that code. Check the number on its screen." };

  const state = linkCodeState(row, now);
  if (state === "expired") return { ok: false, status: 410, code: "code_expired", error: "That code has expired. The printer shows a new one within a minute." };
  if (state !== "pending") return { ok: false, status: 409, code: "code_already_linked", error: "That printer is already paired." };

  const deviceName = (name || "").trim().slice(0, 120) || defaultPrinterName(code);
  const deviceKey = newDeviceKey();
  const { data: device, error: insErr } = await admin
    .from("print_devices")
    .insert({ restaurant_id: restaurant.id, name: deviceName, device_key: deviceKey })
    .select("id, name")
    .single();
  if (insErr || !device) return { ok: false, status: 500, code: "insert_failed", error: insErr?.message || "could not register the printer" };

  const { data: linked } = await admin
    .from(PAIR_TABLE)
    .update({
      restaurant_id: restaurant.id,
      print_device_id: device.id,
      linked_at: new Date(now).toISOString(),
      linked_by: actor,
      device_key: deviceKey,
    })
    .eq("code", code)
    .is("linked_at", null)
    .select("code")
    .maybeSingle();
  if (!linked) {
    await admin.from("print_devices").delete().eq("id", device.id);
    return { ok: false, status: 409, code: "code_already_linked", error: "Somebody paired that code a moment ago." };
  }

  await markPrinterExpected(restaurant.id);
  return { ok: true as const, restaurant, device };
}
