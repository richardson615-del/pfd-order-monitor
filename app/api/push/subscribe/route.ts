import { NextRequest, NextResponse } from "next/server";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";

/** POST body: the PushSubscription object from the browser's Push API. */
export async function POST(req: NextRequest) {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const restaurantIds = await getCurrentUserRestaurantIds();
  if (!restaurantIds.length) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const sub = await req.json();
  const { endpoint, keys } = sub;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  }

  /**
   * Written with the service role, authorised by the session above.
   *
   * push_subscriptions has RLS with insert, select and delete policies and NO
   * UPDATE policy. `.upsert(onConflict: "endpoint")` on an endpoint that
   * already exists IS an update, so it was refused - "new row violates
   * row-level security policy" - for every device that had ever subscribed
   * before. Reported from a live tablet on 2026-09-14.
   *
   * It stayed hidden for months because the old opt-in button only ran when
   * somebody pressed it, and on a fresh browser the endpoint was new, so the
   * path taken was always INSERT. AlertGate re-records on every load, which
   * is what turned a latent hole into a tablet that could not reach its
   * orders.
   *
   * Adding an update policy alone would not be enough: re-binding an endpoint
   * after somebody signs out and signs in as a different restaurant hits a
   * row whose auth_user_id is the PREVIOUS user, which `auth_user_id =
   * auth.uid()` refuses by design. That re-bind is a feature - the same
   * physical tablet moving between restaurants - so the write is done as
   * admin instead.
   *
   * Nothing here is client-controlled in a way that matters: restaurant_id
   * comes from the session's own memberships and auth_user_id from the
   * session. Only the subscription's own endpoint and keys come from the
   * body, which is the browser describing itself.
   */
  const { error } = await supabaseAdmin().from("push_subscriptions").upsert(
    {
      restaurant_id: restaurantIds[0],
      auth_user_id: user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
    { onConflict: "endpoint" }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
