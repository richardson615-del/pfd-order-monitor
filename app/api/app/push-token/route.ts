import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import { cleanOwnerName, isExpoPushToken } from "@/lib/partner-app";
import { registerPushToken, removePushToken } from "@/lib/partner-app-server";

export const dynamic = "force-dynamic";

/**
 * POST   /api/app/push-token { token, platform?, owner_name? } - this phone wants pushes for its restaurant.
 * DELETE /api/app/push-token { token }                          - sign-out: stop them.
 * The restaurant is the session's, never the body's.
 */
export async function POST(req: NextRequest) {
  const {
    data: { user },
  } = await supabaseServer().auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return NextResponse.json({ error: "no restaurant" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) ?? {};
  if (!isExpoPushToken(body.token)) return NextResponse.json({ error: "bad push token" }, { status: 400 });
  const platform = body.platform === "ios" || body.platform === "android" ? body.platform : null;
  const ok = await registerPushToken({ token: body.token, restaurantId, platform, ownerName: cleanOwnerName(body.owner_name) });
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not saved" }, { status: 500 });
}

export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) ?? {};
  if (isExpoPushToken(body.token)) await removePushToken(body.token);
  return NextResponse.json({ ok: true });
}
