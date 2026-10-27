import { NextRequest, NextResponse } from "next/server";
import { passwordLogin } from "@/lib/partner-app-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/app/login { username, password } -> an app session (PA1).
 * PFD Partner's fallback sign-in: the restaurant's own tablet login.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) ?? {};
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const r = await passwordLogin(username, password);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
