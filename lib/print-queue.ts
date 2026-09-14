import { supabaseAdmin } from "./supabase-server";

/**
 * Putting an order on paper, on demand.
 *
 * The ingest path has always done this inline (canonical.ts: one job per
 * active device). Two other places now need the same thing and must not
 * reinvent it — the CRM's test order, and the Print button on the tablet —
 * because the interesting part is not the insert, it is the two rules around
 * it that are easy to get wrong:
 *
 *   1. An EMAIL restaurant has no printer to queue to. Its ticket is made by
 *      a PC running AEM from an email, so a print job there is a row nothing
 *      will ever claim.
 *
 *   2. print_jobs has `unique (order_id, device_id)` from migration 002 — "an
 *      order prints once per device", which is exactly right on ingest and
 *      exactly wrong for a REPRINT. Inserting again fails; so a reprint
 *      re-queues the row that is already there.
 *
 * Re-queueing is not a workaround, it is what a reprint is: print_jobs is a
 * queue, not an audit log, and a row moving back to 'queued' is the same
 * statement as the retry the Epson endpoint already performs on a stale
 * claim. It also means a FAILED job is repaired by the same button — which is
 * the case somebody is most likely to be standing at the printer for.
 */

export type PrintQueueRefusal = "no_active_printer" | "email_restaurant" | "restaurant_not_found";

export interface QueuedPrint {
  jobId: string;
  deviceId: string;
  deviceName: string;
  /** True when an existing job for this order+device was moved back to the queue. */
  requeued: boolean;
}

export interface PrintQueueResult {
  queued: QueuedPrint[];
  refusal?: PrintQueueRefusal;
  /** Human-readable, safe to show. Present whenever `refusal` is. */
  message?: string;
}

/**
 * Queues one order to every ACTIVE printer at its restaurant.
 *
 * Every active one, matching what ingest does, so a reprint puts paper in the
 * same places a real order would rather than in a subset somebody has to
 * reason about.
 *
 * Inactive devices are skipped: the bridge rejects an inactive device's poll,
 * so a job queued there waits forever and reads as a hardware fault.
 */
export async function queueOrderToPrinters(
  orderId: string,
  restaurantId: string
): Promise<PrintQueueResult> {
  const admin = supabaseAdmin();

  const { data: restaurant, error: restaurantError } = await admin
    .from("restaurants")
    .select("id, name, print_method")
    .eq("id", restaurantId)
    .maybeSingle();

  if (restaurantError) {
    return {
      queued: [],
      refusal: "restaurant_not_found",
      message: `could not read the restaurant: ${restaurantError.message}`,
    };
  }
  if (!restaurant) {
    return { queued: [], refusal: "restaurant_not_found", message: "restaurant not found" };
  }

  if (restaurant.print_method === "email") {
    return {
      queued: [],
      refusal: "email_restaurant",
      message:
        "this restaurant's paper ticket is made by emailing a PC, not by a printer here - there is nothing to queue to",
    };
  }

  const { data: devices, error: devicesError } = await admin
    .from("print_devices")
    .select("id, name")
    .eq("restaurant_id", restaurant.id)
    .eq("is_active", true);

  if (devicesError) {
    return {
      queued: [],
      refusal: "no_active_printer",
      message: `could not read this restaurant's printers: ${devicesError.message}`,
    };
  }
  if (!devices?.length) {
    return {
      queued: [],
      refusal: "no_active_printer",
      message: `${restaurant.name} has no active printer`,
    };
  }

  // What is already queued or printed for this order, so each device becomes
  // an update or an insert rather than an insert that fails on the unique
  // index. One read for all of them.
  const { data: existing } = await admin
    .from("print_jobs")
    .select("id, device_id")
    .eq("order_id", orderId)
    .in("device_id", devices.map((d) => d.id));

  const byDevice = new Map((existing ?? []).map((j: any) => [j.device_id, j.id as string]));

  const queued: QueuedPrint[] = [];
  for (const device of devices) {
    const priorJobId = byDevice.get(device.id);

    if (priorJobId) {
      const { error } = await admin
        .from("print_jobs")
        .update({
          status: "queued",
          claimed_at: null,
          finished_at: null,
          // Reset, because the retry budget is per ATTEMPT TO PRINT and this
          // is a new one. A job that had already failed three times would
          // otherwise be handed straight back as failed.
          attempts: 0,
          error: null,
        })
        .eq("id", priorJobId);
      if (error) {
        console.error("reprint: could not re-queue job", priorJobId, "-", error.message);
        continue;
      }
      queued.push({ jobId: priorJobId, deviceId: device.id, deviceName: device.name, requeued: true });
      continue;
    }

    const { data: job, error } = await admin
      .from("print_jobs")
      .insert({ order_id: orderId, device_id: device.id })
      .select("id")
      .single();
    if (error) {
      console.error("reprint: could not queue job for device", device.id, "-", error.message);
      continue;
    }
    queued.push({ jobId: job.id, deviceId: device.id, deviceName: device.name, requeued: false });
  }

  if (queued.length === 0) {
    return {
      queued,
      refusal: "no_active_printer",
      message: `nothing could be queued to ${restaurant.name}'s printer(s) - see the server log`,
    };
  }

  return { queued };
}
