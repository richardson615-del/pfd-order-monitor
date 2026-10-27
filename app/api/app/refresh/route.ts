import { NextRequest, NextResponse } from "next/server";
import { refreshAppSession } from "@/lib/partner-app-server";

export const dynamic = "force-dynamic";

/** POST /api/app/refresh { refresh_token } -> { access_token, refresh_token, expires_at } (PA1). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) ?? {};
  const token = typeof body.refresh_token === "string" && body.refresh_token.length <= 4096 ? body.refresh_token : "";
  if (!token) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const r = await refreshAppSession(token);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
