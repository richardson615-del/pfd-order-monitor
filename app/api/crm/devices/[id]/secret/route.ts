import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { deviceRefKind, isDeviceRef, isSecretHash } from "@/lib/device-binding";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/devices/:ref/secret   { secret_hash: "<sha256 hex>" | null, actor? }
 * GET  /api/crm/devices/:ref/secret
 *
 * The office's half of the device secret (SH1 / Z-02, migration 067).
 *
 * `:ref` is a TABLET's device reference - kiosk_devices.device_ref, the
 * Hexnode serial (or aid:<ANDROID_ID>), URL-encoded - not a printer id.
 * The other routes under /api/crm/devices/:id are about print_devices and
 * take that table's uuid; a uuid here is refused rather than quietly
 * becoming a tablet nobody owns.
 *
 * The CRM generates the secret (32 random bytes, sent to the tablet as
 * url-safe text through Hexnode managed app configuration, key
 * `device_secret`), shows it once, and sends this bridge ONLY its sha256.
 * The bridge never sees the secret and cannot give it back: GET answers
 * whether one is set, never the hash. `null` clears it.
 *
 * Setting one for a serial the bridge has not seen yet records the row,
 * unassigned, so a tablet can be given its secret while it is still stock.
 * Assigning it is still POST /api/crm/tablets/bind.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const ref = deviceRefFrom(params.id);
  if (!ref) return NextResponse.json(BAD_REF, { status: 400 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("secret_hash" in body)) {
    return NextResponse.json(
      { code: "invalid_secret_hash", error: "secret_hash required: the sha256 of the secret as 64 hex characters, or null to clear it" },
      { status: 400 }
    );
  }
  // The secret itself has no business here. Refused before anything is
  // written, and deliberately not echoed or logged.
  if ("secret" in body) {
    return NextResponse.json(
      { code: "secret_not_accepted", error: "send secret_hash only - the bridge must never receive the secret itself" },
      { status: 400 }
    );
  }
  const raw = (body as { secret_hash: unknown }).secret_hash;
  const hash = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (hash !== null && !isSecretHash(hash)) {
    return NextResponse.json(
      { code: "invalid_secret_hash", error: "secret_hash must be the sha256 of the secret as 64 hex characters, or null to clear it" },
      { status: 400 }
    );
  }
  const actor = typeof (body as { actor?: unknown }).actor === "string" && (body as { actor: string }).actor.trim()
    ? (body as { actor: string }).actor.trim().slice(0, 200)
    : null;

  const admin = supabaseAdmin();
  const nowIso = new Date().toISOString();

  const { data: before, error: readError } = await admin
    .from("kiosk_devices")
    .select("device_ref, restaurant_id")
    .eq("device_ref", ref)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

  if (hash === null) {
    // Clearing a reference the bridge has never seen changes nothing and creates nothing.
    if (before) {
      const { error } = await admin.from("kiosk_devices").update({ secret_hash: null, updated_at: nowIso }).eq("device_ref", ref);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } else {
    // Only these columns: an existing row keeps its restaurant and everything else.
    const { error } = await admin
      .from("kiosk_devices")
      .upsert({ device_ref: ref, secret_hash: hash, updated_at: nowIso }, { onConflict: "device_ref" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Who and which tablet - never the hash.
  console.log(`kiosk device secret ${hash === null ? "cleared" : "set"} for ${ref} by ${actor ?? "unknown"}`);

  return NextResponse.json({
    ok: true,
    device_ref: ref,
    kind: deviceRefKind(ref),
    has_secret: hash !== null,
    bound: Boolean((before as { restaurant_id?: string | null } | null)?.restaurant_id),
    created: !before && hash !== null,
  });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const ref = deviceRefFrom(params.id);
  if (!ref) return NextResponse.json(BAD_REF, { status: 400 });

  // The hash is selected to answer yes or no and goes no further than this function.
  const { data, error } = await supabaseAdmin()
    .from("kiosk_devices")
    .select("restaurant_id, secret_hash")
    .eq("device_ref", ref)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = data as { restaurant_id: string | null; secret_hash: string | null } | null;
  return NextResponse.json(
    {
      device_ref: ref,
      kind: deviceRefKind(ref),
      known: Boolean(row),
      has_secret: row?.secret_hash != null,
      bound: Boolean(row?.restaurant_id),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

const BAD_REF = {
  code: "invalid_device_ref",
  error: "the path takes a tablet device reference (its serial, or aid:<id>), not a printer id",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The reference from the path segment: decoded if it arrived encoded, and never a uuid (those are printers). */
function deviceRefFrom(segment: string): string | null {
  let ref = segment;
  try {
    ref = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (!isDeviceRef(ref) || UUID.test(ref)) return null;
  return ref;
}
