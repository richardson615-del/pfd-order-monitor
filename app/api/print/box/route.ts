import { NextRequest, NextResponse } from "next/server";
import { MAX_SHOT_BYTES, boxReply, parseBoxRequest } from "@/lib/orderbox";
import {
  boxAck,
  boxBusy,
  boxDeny,
  boxDone,
  boxHealth,
  boxItem86,
  boxLate,
  boxMenu,
  boxMessage,
  boxPause,
  boxPrep,
  boxRead,
  boxReady,
  boxReprint,
  boxShot,
  boxSync,
  findBoxDevice,
  type BoxResult,
} from "@/lib/orderbox-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/print/box - PFD's touchscreen order box (lib/orderbox.ts).
 *
 * Form body: ID=<device key>&Action=<action>&... ; answers key=value lines,
 * ok=1 or ok=0 first. A screenshot is the one binary post: the frame is the
 * body (application/octet-stream) and ID, Action=Shot, W and H ride in the
 * query string. The key decides the restaurant; nothing in the body can name
 * another one. Contract: docs/crm-bridge-contract.md, "The order box".
 */
export async function POST(req: NextRequest) {
  const isBinary = (req.headers.get("content-type") ?? "").startsWith("application/octet-stream");
  let form: URLSearchParams;
  let body: Uint8Array | null = null;
  if (isBinary) {
    form = req.nextUrl.searchParams;
    const len = Number(req.headers.get("content-length") ?? "0");
    if (len > MAX_SHOT_BYTES) return text({ status: 413, body: boxReply([["ok", 0], ["error", "frame too large"]]) });
    body = new Uint8Array(await req.arrayBuffer());
    if (body.length > MAX_SHOT_BYTES) return text({ status: 413, body: boxReply([["ok", 0], ["error", "frame too large"]]) });
  } else {
    form = new URLSearchParams(await req.text().catch(() => ""));
  }

  const device = await findBoxDevice((form.get("ID") ?? "").trim());
  if (!device) return text({ status: 401, body: boxReply([["ok", 0], ["error", "not paired"]]) });

  const parsed = parseBoxRequest(form);
  if ("error" in parsed) return text({ status: 400, body: boxReply([["ok", 0], ["error", parsed.error]]) });
  const r = (parsed as { req: import("@/lib/orderbox").BoxRequest }).req;

  try {
    switch (r.action) {
      case "Sync": return text(await boxSync(device));
      case "Ack": return text(await boxAck(device, r.orderId, r.minutes));
      case "Ready": return text(await boxReady(device, r.orderId));
      case "Late": return text(await boxLate(device, r.orderId, r.add));
      case "Prep": return text(await boxPrep(device, r.orderId, r.minutes));
      case "Busy": return text(await boxBusy(device, r));
      case "Pause": return text(await boxPause(device, r));
      case "Msg": return text(await boxMessage(device, r.key, r.orderId));
      case "Read": return text(await boxRead(device));
      case "Menu": return text(await boxMenu(device));
      case "Item86": return text(await boxItem86(device, r.ref, r.soldOut));
      case "Deny": return text(await boxDeny(device, r.orderId, r.code));
      case "Health": return text(await boxHealth(device, r.printer, r.link));
      case "Done": return text(await boxDone(device, r.command, r.result));
      case "Reprint": return text(await boxReprint(device, r.orderId));
      case "Shot":
        if (!body) return text({ status: 400, body: boxReply([["ok", 0], ["error", "send the frame as the body"]]) });
        return text(await boxShot(device, body, r.width, r.height));
    }
  } catch (e) {
    console.error("order box", r.action, e instanceof Error ? e.message : e);
    return text({ status: 500, body: boxReply([["ok", 0], ["error", "Server problem. Try again."]]) });
  }
}

function text(r: BoxResult) {
  return new NextResponse(r.body, { status: r.status, headers: { "Content-Type": "text/plain; charset=us-ascii", "Cache-Control": "no-store" } });
}
