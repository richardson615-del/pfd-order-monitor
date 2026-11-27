import { NextRequest, NextResponse } from "next/server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { resolveRestaurantIds } from "@/lib/restaurant-ref";
import { parseBindings, secretsEndedByBind } from "@/lib/device-binding";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/tablets/bind
 *   { device_ref, restaurant_id | null, model?, actor? }
 *   or { bindings: [ ...same... ], actor? }
 *
 * The CRM tells the bridge which tablet belongs to which restaurant. The
 * CRM owns the assignment (its tablets inventory); the bridge holds a copy
 * so a tablet can boot without the CRM answering. Sent on assign and
 * unassign (one entry) and after every MDM sync (the whole map), and
 * upserted either way. restaurant_id null unbinds.
 *
 * A restaurant id the bridge does not know is refused for that entry and
 * named in the response; the rest still land.
 *
 * Device secrets (SH1, migration 067): a push that leaves a tablet on the
 * same restaurant touches nothing. One that moves or unassigns an `aid:`
 * tablet clears its secret_hash first - that secret was issued for the old
 * restaurant - and a Hexnode serial keeps its own (the rule and the reasons:
 * secretsEndedByBind in lib/device-binding.ts). `secrets_cleared` counts them.
 */
export async function POST(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const bindings = parseBindings(body);
  if (!bindings || bindings.length === 0) {
    return NextResponse.json({ error: "bindings required: [{ device_ref, restaurant_id | null }]" }, { status: 400 });
  }
  if (bindings.length > 2000) return NextResponse.json({ error: "too many bindings in one call" }, { status: 400 });
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 200) : null;

  const admin = supabaseAdmin();
  // The CRM sends ITS account id (restaurants.crm_restaurant_id), not this
  // database's uuid - the two are different values (lib/restaurant-ref.ts).
  // Resolve every reference to the local id before it is written, because
  // kiosk_devices.restaurant_id is a foreign key to restaurants.id.
  const wanted = [...new Set(bindings.map((b) => b.restaurant_id).filter((x): x is string => Boolean(x)))];
  const localIdOf = await resolveRestaurantIds(wanted);

  const nowIso = new Date().toISOString();
  const rows = [];
  const unknown_restaurants: string[] = [];
  for (const b of bindings) {
    const localId = b.restaurant_id ? (localIdOf.get(b.restaurant_id) ?? null) : null;
    if (b.restaurant_id && !localId) {
      unknown_restaurants.push(b.restaurant_id);
      continue;
    }
    rows.push({
      device_ref: b.device_ref,
      restaurant_id: localId,
      ...(b.model ? { model: b.model } : {}),
      bound_at: b.restaurant_id ? nowIso : null,
      bound_by: b.restaurant_id ? actor : null,
      updated_at: nowIso,
    });
  }

  // Before the bindings land, never after: if this fails the call fails
  // with the old bindings intact, and a secret cleared without its move is
  // only a tablet that has to be linked by code - the safe side to fail on.
  let secretsCleared = 0;
  if (rows.length) {
    const held = await rowsHoldingSecrets(admin);
    if ("error" in held) return NextResponse.json({ error: held.error }, { status: 500 });
    const ended = secretsEndedByBind(held.rows, rows);
    for (let i = 0; i < ended.length; i += 100) {
      const { error } = await admin
        .from("kiosk_devices")
        .update({ secret_hash: null, updated_at: nowIso })
        .in("device_ref", ended.slice(i, i + 100));
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    secretsCleared = ended.length;
  }

  if (rows.length) {
    const { error } = await admin.from("kiosk_devices").upsert(rows, { onConflict: "device_ref" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    bound: rows.filter((r) => r.restaurant_id).length,
    unbound: rows.filter((r) => !r.restaurant_id).length,
    unknown_restaurants,
    secrets_cleared: secretsCleared,
  });
}

/**
 * Every row that holds a device secret: reference and current restaurant,
 * never the hash. Read whole (a fleet is hundreds of rows, and the CRM's
 * full-map push can name two thousand references - too many for one filter).
 *
 * "The column does not exist" (067 not applied yet) is an empty list, not a
 * failure: no row can hold a secret, and binding must keep working. Any
 * other error stops the call - guessing "nothing to clear" would let a
 * moved tablet keep a secret it should have lost.
 */
async function rowsHoldingSecrets(
  admin: ReturnType<typeof supabaseAdmin>
): Promise<{ rows: { device_ref: string; restaurant_id: string | null }[] } | { error: string }> {
  const out: { device_ref: string; restaurant_id: string | null }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("kiosk_devices")
      .select("device_ref, restaurant_id")
      .not("secret_hash", "is", null)
      .order("device_ref")
      .range(from, from + PAGE - 1);
    if (error) {
      if (error.code === "42703" && /secret_hash/.test(error.message ?? "")) return { rows: [] };
      return { error: error.message };
    }
    const page = (data ?? []) as { device_ref: string; restaurant_id: string | null }[];
    out.push(...page);
    if (page.length < PAGE) return { rows: out };
  }
}
