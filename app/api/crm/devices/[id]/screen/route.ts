import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { UUID_RE } from "@/lib/restaurant-ref";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/devices/:id/screen -> image/png (066, PFD's order box)
 *
 * The box's latest screenshot, taken after the CRM queued
 * { action: "box_command", command: "screenshot" }. Half size (400x240 for a
 * landscape panel, 240x400 in portrait). X-Taken-At says when. 404 when the
 * box has never sent one.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: "device not found" }, { status: 404 });
  const { data, error } = await supabaseAdmin().from("device_screens").select("png, taken_at").eq("device_id", params.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "no screenshot yet", code: "no_screenshot" }, { status: 404 });
  const png = bytesOf(data.png);
  return new NextResponse(new Uint8Array(png), {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Taken-At": data.taken_at },
  });
}

/** PostgREST hands bytea back as "\x89504e47..." */
function bytesOf(v: unknown): Buffer {
  if (typeof v === "string") return Buffer.from(v.startsWith("\\x") ? v.slice(2) : v, v.startsWith("\\x") ? "hex" : "base64");
  return Buffer.from(v as ArrayBuffer);
}
