import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import {
  LINK_CODE_RATE_WINDOW_MS,
  LINK_CODE_TTL_MS,
  LINK_STATUS_POLL_MS,
  generateLinkCode,
  isDeviceId,
  isLinkCode,
  linkCodeState,
  mayCreateLinkCode,
} from "@/lib/link-code";
import { PAIR_TABLE, mayCollectKey } from "@/lib/printer-pairing";

export const dynamic = "force-dynamic";

/**
 * POST /api/print/link   (form-encoded, plain-text reply - the printer is an ESP32)
 *
 *   Action=Code&Device=<id>               -> code=123456\nexpires=<iso>\npoll=5000
 *   Action=Status&Device=<id>&Code=123456 -> status=pending | expired | consumed
 *                                            status=linked\nkey=PFD-...\nrestaurant=<name>
 *
 * Unauthenticated by necessity, like /api/kiosk/link-code: the caller has no
 * key yet. A code is useless to anyone but the office (who need admin or CRM
 * access to pair it) and the printer that asked (the only one that can
 * collect the key, once). Codes are rate-limited per address; a code that
 * belongs to another device answers 404 like one that does not exist.
 */
export async function POST(req: NextRequest) {
  const form = new URLSearchParams(await req.text().catch(() => ""));
  const action = form.get("Action") || "";
  const device = form.get("Device") || "";
  if (!isDeviceId(device)) return text("error=device id required", 400);

  if (action === "Code") return issueCode(req, device);
  if (action === "Status") return status(device, (form.get("Code") || "").trim());
  return text("error=unknown action", 400);
}

async function issueCode(req: NextRequest, device: string) {
  const admin = supabaseAdmin();
  const now = Date.now();
  const ip = clientIp(req);

  // The printer's own pending code, if it still has one: a reboot must not
  // change the number somebody is reading out.
  const { data: existing } = await admin
    .from(PAIR_TABLE)
    .select("code, device_id, expires_at, restaurant_id, linked_at, device_key, consumed_at")
    .eq("device_id", device)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    const st = linkCodeState(existing, now);
    if (st === "pending" || st === "linked") return text(reply(existing.code, existing.expires_at));
  }

  const { count } = await admin
    .from(PAIR_TABLE)
    .select("code", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("created_at", new Date(now - LINK_CODE_RATE_WINDOW_MS).toISOString());
  if (!mayCreateLinkCode(count ?? 0)) return text("error=too many codes from this address", 429);

  const expiresAt = new Date(now + LINK_CODE_TTL_MS).toISOString();
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateLinkCode((n) => Uint8Array.from(randomBytes(n)));
    const { error } = await admin.from(PAIR_TABLE).insert({ code, device_id: device, ip, expires_at: expiresAt });
    if (!error) return text(reply(code, expiresAt));
    if (!/duplicate|unique|already exists/i.test(error.message)) return text("error=" + error.message, 500);
  }
  return text("error=could not allocate a code", 503);
}

async function status(device: string, code: string) {
  if (!isLinkCode(code)) return text("error=code required", 400);
  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from(PAIR_TABLE)
    .select("code, device_id, expires_at, restaurant_id, linked_at, device_key, consumed_at")
    .eq("code", code)
    .maybeSingle();
  if (!row || row.device_id !== device) return text("error=unknown code", 404);

  const now = Date.now();
  if (!mayCollectKey(row, device, now)) return text("status=" + linkCodeState(row, now));

  // Claim, then blank the key. The `is null` guard means two racing polls
  // cannot both be handed the key.
  const { data: claimed } = await admin
    .from(PAIR_TABLE)
    .update({ consumed_at: new Date(now).toISOString() })
    .eq("code", code)
    .is("consumed_at", null)
    .select("device_key, restaurant_id")
    .maybeSingle();
  if (!claimed?.device_key) return text("status=consumed");
  await admin.from(PAIR_TABLE).update({ device_key: null }).eq("code", code);

  const { data: restaurant } = await admin.from("restaurants").select("name").eq("id", claimed.restaurant_id).maybeSingle();
  const name = (restaurant?.name || "").replace(/[\r\n]/g, " ");
  return text(`status=linked\nkey=${claimed.device_key}\nrestaurant=${name}`);
}

function reply(code: string, expiresAt: string) {
  return `code=${code}\nexpires=${expiresAt}\npoll=${LINK_STATUS_POLL_MS}`;
}

function text(body: string, status = 200) {
  return new NextResponse(body + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0]?.trim();
  return (first || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
}
