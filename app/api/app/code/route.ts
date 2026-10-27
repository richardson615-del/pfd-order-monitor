import { NextRequest, NextResponse } from "next/server";
import { normalizePhone } from "@/lib/partner-app";
import { requestLoginCode } from "@/lib/partner-app-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/app/code { phone } -> { ok } (PA1).
 * Texts a sign-in code when the phone is an owner's on file. The answer is
 * the same either way, so this can't be used to find owners' numbers.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) ?? {};
  const phone = normalizePhone(body.phone);
  if (!phone) return NextResponse.json({ error: "Enter a 10-digit US cell number." }, { status: 400 });
  const r = await requestLoginCode(phone);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}
