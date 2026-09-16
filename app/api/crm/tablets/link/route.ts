import { NextRequest, NextResponse } from "next/server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { ensureTabletLogin } from "@/lib/provision";
import { isLinkCode, linkCodeState, tokenHashFrom } from "@/lib/link-code";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/tablets/link   { code, restaurant_id, actor? }
 *
 * The office half of pairing. A tablet with no session is showing a
 * six-digit code and "Call Premium"; somebody in the CRM types the code
 * against the restaurant it belongs to, and this turns that into a session
 * on that tablet - without a username or a password ever being shown on
 * the tablet, read over the phone, or typed in a kitchen.
 *
 * How the session is made: the restaurant's tablet login (found or created
 * by the same rule provisioning uses - never a second login, never a reset
 * password) gets a Supabase magic link generated server-side. Nothing is
 * emailed; the hashed token is stored on the code row, and the device the
 * code was issued to collects it once from /api/kiosk/link-status and
 * verifies it in the browser, which is what sets the session cookies.
 *
 * 404 unknown code · 410 expired · 409 already linked. Each names the
 * state, because the person on the phone needs to say "read me a new one"
 * versus "it's done, reload the tablet".
 */
export async function POST(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : null;
  const restaurantId = typeof body?.restaurant_id === "string" ? body.restaurant_id : null;
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 200) : null;
  if (!isLinkCode(code)) return NextResponse.json({ error: "code must be six digits" }, { status: 400 });
  if (!restaurantId) return NextResponse.json({ error: "restaurant_id required" }, { status: 400 });

  const admin = supabaseAdmin();
  const now = Date.now();

  const { data: row } = await admin
    .from("kiosk_link_codes")
    .select("code, device_id, expires_at, restaurant_id, linked_at, token_hash, consumed_at")
    .eq("code", code)
    .maybeSingle();
  // `code` + `error`, the shape the CRM's bridge client turns into a refusal
  // the person on the phone can act on (asRefusal in prs-crm).
  if (!row) return NextResponse.json({ code: "code_not_found", error: "No tablet is showing that code. Ask them to read it again." }, { status: 404 });

  const state = linkCodeState(row, now);
  if (state === "expired") {
    return NextResponse.json(
      { code: "code_expired", error: "That code has expired. The tablet shows a new one - ask for it." },
      { status: 410 }
    );
  }
  if (state !== "pending") {
    return NextResponse.json(
      { code: "code_already_linked", error: "That code has already been linked. The tablet should be showing orders." },
      { status: 409 }
    );
  }

  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name")
    .eq("id", restaurantId)
    .maybeSingle();
  if (!restaurant) return NextResponse.json({ code: "restaurant_not_found", error: "restaurant not found" }, { status: 404 });

  try {
    const login = await ensureTabletLogin(restaurant, actor);

    const { data: generated, error: genError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: login.email,
    });
    const tokenHash = tokenHashFrom(generated);
    if (genError || !tokenHash) {
      return NextResponse.json(
        { error: genError?.message ?? "auth did not return a usable link" },
        { status: 502 }
      );
    }

    // Written only onto a still-pending row, so two office users linking
    // the same code to two restaurants cannot both succeed.
    const { data: linked } = await admin
      .from("kiosk_link_codes")
      .update({
        restaurant_id: restaurant.id,
        linked_at: new Date(now).toISOString(),
        linked_by: actor,
        token_hash: tokenHash,
      })
      .eq("code", code)
      .is("linked_at", null)
      .select("code")
      .maybeSingle();
    if (!linked) {
      return NextResponse.json(
        { code: "code_already_linked", error: "Somebody linked that code a moment ago." },
        { status: 409 }
      );
    }

    await admin
      .from("restaurant_login_audit")
      .insert({
        restaurant_id: restaurant.id,
        username: login.username,
        action: "linked",
        actor,
        note: `tablet linked with code ${code} (device ${row.device_id.slice(0, 8)}…)`,
      })
      .then(({ error }) => {
        if (error) console.error("login audit not recorded:", error.message);
      });

    return NextResponse.json({
      ok: true,
      restaurant: { id: restaurant.id, name: restaurant.name },
      login: { username: login.username, created: login.created },
      // Not the token. The office never sees the thing that becomes a session.
      note: `Linked. The tablet picks it up within a few seconds and shows ${restaurant.name}'s orders.`,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
