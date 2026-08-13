import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { buildTicket, toEposPrintXml } from "@/lib/ticket";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Epson Server Direct Print endpoint.
 *
 * The printer polls THIS url on a timer and prints whatever we return, so a
 * site needs no agent, no PC and no app - only the printer. That is the
 * difference between shipping a box to a restaurant and installing software
 * there, which is what makes it the scalable deployment.
 *
 * Protocol (Server Direct Print User's Manual, rev K):
 *
 *   printer -> us   POST application/x-www-form-urlencoded
 *                   ConnectionType=GetRequest&ID=<id set in WebConfig>
 *   us -> printer   200 text/xml  <PrintRequestInfo Version="2.00">...
 *                   or an EMPTY body when there is nothing to print
 *   printer -> us   ConnectionType=SetResponse&ID=...&ResponseFile=<result xml>
 *   us -> printer   200 empty
 *
 * The WebConfig "ID" field carries our existing print_devices.device_key, so
 * this reuses the same device identity as the pull agent.
 */

/** Nothing to print / not our device: an empty 200 keeps the printer polling. */
const empty = () =>
  new NextResponse("", { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } });

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } });

/**
 * printjobid has a modest length limit and our job ids are 36-char uuids, so
 * send the hyphen-stripped uuid (32 chars) and match on it coming back.
 */
const toJobId = (uuid: string) => uuid.replace(/-/g, "");

async function findDevice(deviceKey: string) {
  const admin = supabaseAdmin();
  const { data: device } = await admin
    .from("print_devices")
    .select("id, restaurant_id, name")
    .eq("device_key", deviceKey)
    .eq("is_active", true)
    .maybeSingle();
  if (!device) return null;

  // Same device-health stamping as the pull agent, so /admin shows liveness
  // regardless of which transport a site uses.
  await admin
    .from("print_devices")
    .update({ last_seen_at: new Date().toISOString(), app_version: "server-direct-print" })
    .eq("id", device.id);

  return device;
}

async function handleGetRequest(deviceKey: string) {
  const device = await findDevice(deviceKey);
  if (!device) return empty();

  const admin = supabaseAdmin();
  const staleCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  // Re-offer anything claimed but never reported (printer lost power mid-job).
  await admin
    .from("print_jobs")
    .update({ status: "queued", claimed_at: null })
    .eq("device_id", device.id)
    .eq("status", "claimed")
    .lt("claimed_at", staleCutoff);

  const { data: jobs } = await admin
    .from("print_jobs")
    .select(
      `id, order_id,
       orders ( order_number, source, ticket_restaurant_name, order_type, due_time,
                customer_name, customer_phone, customer_address, items, items_total,
                tax, service_fee, delivery_fee, tip, customer_total, payment_type,
                notes, received_at )`
    )
    .eq("device_id", device.id)
    .eq("status", "queued")
    .order("queued_at", { ascending: true })
    .limit(5);

  if (!jobs?.length) return empty();

  const printable = jobs.filter((j: any) => j.orders);
  if (!printable.length) return empty();

  // Claim before handing them over, so a second poll cannot print them twice.
  await admin
    .from("print_jobs")
    .update({ status: "claimed", claimed_at: new Date().toISOString() })
    .in("id", printable.map((j: any) => j.id))
    .eq("status", "queued");

  const cols = Number(process.env.TICKET_COLS || 48);
  const blocks = printable
    .map((job: any) => {
      const data = toEposPrintXml(buildTicket(job.orders, cols), cols);
      return `<ePOSPrint><Parameter><devid>local_printer</devid><timeout>10000</timeout><printjobid>${toJobId(job.id)}</printjobid></Parameter><PrintData>${data}</PrintData></ePOSPrint>`;
    })
    .join("");

  return xml(
    `<?xml version="1.0" encoding="utf-8"?>\n<PrintRequestInfo Version="2.00">${blocks}</PrintRequestInfo>`
  );
}

async function handleSetResponse(deviceKey: string, responseFile: string) {
  const device = await findDevice(deviceKey);
  if (!device) return empty();

  const jobIdRaw = responseFile.match(/<printjobid>([^<]*)<\/printjobid>/i)?.[1]?.trim();
  const success = /success="true"/i.test(responseFile);
  const code = responseFile.match(/code="([^"]*)"/i)?.[1] || "";

  const admin = supabaseAdmin();

  // Version 1.00 responses carry no printjobid, so fall back to the oldest
  // outstanding claim for this device rather than dropping the result.
  const { data: claimed } = await admin
    .from("print_jobs")
    .select("id, attempts")
    .eq("device_id", device.id)
    .eq("status", "claimed")
    .order("claimed_at", { ascending: true });

  const job = jobIdRaw
    ? claimed?.find((j) => toJobId(j.id) === jobIdRaw)
    : claimed?.[0];

  if (!job) return empty();

  if (success) {
    await admin
      .from("print_jobs")
      .update({ status: "printed", finished_at: new Date().toISOString() })
      .eq("id", job.id);
    const { data: full } = await admin
      .from("print_jobs").select("order_id").eq("id", job.id).maybeSingle();
    if (full?.order_id) {
      await admin
        .from("orders")
        .update({ status: "printed", printed_at: new Date().toISOString() })
        .eq("id", full.order_id);
    }
    return empty();
  }

  const attempts = (job.attempts ?? 0) + 1;
  const willRetry = attempts < 3;
  console.error("Server Direct Print failed", { jobId: job.id, code, attempts });
  await admin
    .from("print_jobs")
    .update({
      status: willRetry ? "queued" : "failed",
      attempts,
      error: `ePOS code="${code}"`.slice(0, 500),
      claimed_at: null,
      finished_at: willRetry ? null : new Date().toISOString(),
    })
    .eq("id", job.id);

  return empty();
}

export async function POST(req: NextRequest) {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return empty();
  }

  const connectionType = form.get("ConnectionType") || "";
  const deviceKey = (form.get("ID") || "").trim();
  if (!deviceKey) return empty();

  if (connectionType === "GetRequest") return handleGetRequest(deviceKey);
  if (connectionType === "SetResponse") {
    return handleSetResponse(deviceKey, form.get("ResponseFile") || "");
  }

  // Status notification and anything else: acknowledge with an empty response.
  return empty();
}
