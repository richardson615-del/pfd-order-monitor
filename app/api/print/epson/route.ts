import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { buildTicket, toEposPrintXml } from "@/lib/ticket";
import { renderHeader, renderFooter, toEposImageXml, DEFAULT_FOOTER_TEXT_MARK } from "@/lib/ticket-raster";

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
    .select("id, restaurant_id, name, text_scale")
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

/** The DUE line, lifted for the raster header so it is not printed twice. */
function dueLineOf(lines: any[]): string | null {
  const l = lines.find((x: any) => /^DUE /.test(x.text ?? ""));
  return l ? l.text : null;
}

/**
 * The body between the header and footer blocks, which the raster now owns.
 * Bounded by the ORDER # line and the heavy rule that opens the footer.
 */
function sliceBody(lines: any[]): any[] {
  const start = lines.findIndex((l: any) => /^ORDER #/.test(l.text ?? ""));
  const end = lines.findIndex((l: any, i: number) => i > start && /^=+$/.test(l.text ?? ""));
  if (start === -1) return lines;
  return lines.slice(start, end === -1 ? lines.length : end);
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
                notes, received_at, footer_resolved,
                restaurants ( name, ticket_footer_text, ticket_footer_url, ticket_text_scale,
                              ticket_design_style, ticket_logo_b64,
                              ticket_footer_mode, ticket_footer_image_b64 ) )`
    )
    .eq("device_id", device.id)
    .eq("status", "queued")
    .order("queued_at", { ascending: true })
    // One job per response. PrintRequestInfo 1.00 carries no printjobid, so
    // results are matched back by oldest-outstanding-claim - which is only
    // unambiguous with a single job in flight. The printer polls every few
    // seconds, so a queue drains almost as fast either way.
    .limit(1);

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
  const blocks = (
    await Promise.all(
      printable.map(async (job: any) => {
        const r = job.orders?.restaurants;
        // Device setting wins; null means inherit the restaurant's default.
        const scale = (device as any).text_scale || r?.ticket_text_scale || "normal";
        const design = {
          style: r?.ticket_design_style || "bold",
          footerText: r?.ticket_footer_text,
          footerUrl: r?.ticket_footer_url,
        };

        // A footer resolved at ingest wins over the static columns. Printing
        // never computes one - it only reads what was already decided.
        const resolved = job.orders?.footer_resolved as
          | { text?: string; url?: string | null }
          | null;
        const footerContent = resolved?.text
          ? { text: resolved.text, url: resolved.url ?? null }
          : { text: r?.ticket_footer_text, url: r?.ticket_footer_url };

        const lines = buildTicket(job.orders, cols, footerContent, { scale });

        // The raster blocks own the header and footer, so the text renderer's
        // versions are dropped rather than printed twice.
        const bodyLines = sliceBody(lines);

        let head = "";
        let foot = "";
        try {
          const logo = r?.ticket_logo_b64 ? Buffer.from(r.ticket_logo_b64, "base64") : null;
          const header = await renderHeader({
            restaurantName: r?.name || job.orders?.ticket_restaurant_name || "PFD ORDER",
            orderType: job.orders?.order_type || "order",
            dueText: dueLineOf(lines),
            design, logo,
          });
          head = toEposImageXml(header);
          // A dynamic template supplies text and a QR target, so forcing the
          // footer to "image" would throw its coupon code away. Image mode is
          // therefore a STATIC-engine choice only.
          const footerMode =
            resolved?.text ? "qr_with_text" : (r?.ticket_footer_mode || "qr_with_text");
          const footerImage =
            footerMode === "image" && r?.ticket_footer_image_b64
              ? Buffer.from(r.ticket_footer_image_b64, "base64")
              : null;

          const footer = await renderFooter({
            text: (footerContent.text || "").trim() || DEFAULT_FOOTER_TEXT_MARK,
            url: footerContent.url, design,
            mode: footerMode as any,
            image: footerImage,
          });
          foot = toEposImageXml(footer);
        } catch (err) {
          // A design that will not render must never cost the kitchen its
          // ticket - fall back to the all-text layout, loudly.
          console.error("ticket raster failed, printing text-only:", err instanceof Error ? err.message : err);
          return `<ePOSPrint><Parameter><devid>local_printer</devid><timeout>10000</timeout></Parameter><PrintData>${toEposPrintXml(lines, cols)}</PrintData></ePOSPrint>`;
        }

        const body = toEposPrintXml(bodyLines, cols, { wrap: false });
        const data =
          `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">` +
          head + body + foot +
          `<feed line="3"/><cut type="feed"/></epos-print>`;
        return `<ePOSPrint><Parameter><devid>local_printer</devid><timeout>20000</timeout></Parameter><PrintData>${data}</PrintData></ePOSPrint>`;
      })
    )
  ).join("");

  // Version 1.00: supported by every TM-i firmware. 2.00 adds printjobid but
  // needs firmware 4.1+, and this printer answers it with SchemaError - which
  // surfaces as a failed print, not a clear error, so compatibility wins.
  return xml(
    `<?xml version="1.0" encoding="utf-8"?>\n<PrintRequestInfo Version="1.00">${blocks}</PrintRequestInfo>`
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
