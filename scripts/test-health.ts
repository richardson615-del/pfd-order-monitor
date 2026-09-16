/**
 * Assertions for the health checks. An alerting system that is wrong is
 * worse than none - it either cries wolf until people mute it, or stays
 * quiet during the outage it existed to catch. Both directions are tested.
 */
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLDS, evaluateHealth, sortIssues, type HealthSnapshot } from "@/lib/health";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

const NOW = new Date("2026-08-14T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

const healthy: HealthSnapshot = {
  devices: [{ id: "d1", name: "Kitchen printer", restaurant_id: "r1", restaurant_name: "China One", is_active: true, last_seen_at: minsAgo(0) }],
  inboxes: [{ id: "i1", email_address: "a@b.com", restaurant_id: "r1", restaurant_name: "China One", is_active: true, has_token: true, last_poll_at: minsAgo(1) }],
  restaurantsWithoutDevice: [],
  pendingJobs: [],
  failedJobs: [],
  unreconciledOrders: [],
  unsentEmailJobs: [],
  undeliveredAppAlerts: [],
  restaurantsWithoutAppDevice: [],
  tabletsNotWatching: [], unacceptedOrders: [],
  webhook: {
    lastReceiptAt: minsAgo(5),
    lastAcceptedAt: minsAgo(5),
    recentTotal: 3,
    recentRejected: 0,
    recentWindowHours: 6,
    recentRejectedSources: [],
  },
  cronRuns: [
    { job: "gmail_poll", last_run_at: minsAgo(1) },
    { job: "monitor_check", last_run_at: minsAgo(5) },
  ],
  restaurantVolumes: [],
};

console.log("healthy system:");

test("a healthy system produces no issues", () =>
  assert.deepEqual(evaluateHealth(healthy, NOW), []));

test("a device seen just under the threshold is not flagged", () => {
  const s = { ...healthy, devices: [{ ...healthy.devices[0], last_seen_at: minsAgo(DEFAULT_THRESHOLDS.deviceSilentMinutes - 1) }] };
  assert.equal(evaluateHealth(s, NOW).length, 0, "must not cry wolf on a brief blip");
});

test("an inactive device is ignored, even if silent for days", () => {
  const s = { ...healthy, devices: [{ ...healthy.devices[0], is_active: false, last_seen_at: minsAgo(10000) }] };
  assert.equal(evaluateHealth(s, NOW).length, 0);
});

test("an inactive inbox is ignored (deliberately switched off)", () => {
  const s = { ...healthy, inboxes: [{ ...healthy.inboxes[0], is_active: false, has_token: false, last_poll_at: null }] };
  assert.equal(evaluateHealth(s, NOW).length, 0);
});

console.log("real failures this system has produced:");

test("printer offline is critical", () => {
  const s = { ...healthy, devices: [{ ...healthy.devices[0], last_seen_at: minsAgo(30) }] };
  const [i] = evaluateHealth(s, NOW);
  assert.equal(i.severity, "critical");
  assert.match(i.title, /Printer offline/);
  assert.match(i.detail, /30 min ago/);
});

test("a registered printer that never checked in is flagged", () => {
  const s = { ...healthy, devices: [{ ...healthy.devices[0], last_seen_at: null }] };
  const [i] = evaluateHealth(s, NOW);
  assert.match(i.key, /device_never_seen/);
  assert.match(i.detail, /never contacted/);
});

// The Gmail token died with the old Google project and nothing said so.
test("an inbox with no Gmail access is critical", () => {
  const s = { ...healthy, inboxes: [{ ...healthy.inboxes[0], has_token: false }] };
  const [i] = evaluateHealth(s, NOW);
  assert.equal(i.severity, "critical");
  assert.match(i.title, /not connected/);
});

test("an inbox that stopped polling is critical", () => {
  const s = { ...healthy, inboxes: [{ ...healthy.inboxes[0], last_poll_at: minsAgo(90) }] };
  const [i] = evaluateHealth(s, NOW);
  assert.match(i.key, /inbox_stalled/);
  assert.match(i.detail, /1h ago/);
});

// An order ingested cleanly and printed nowhere, because the printer was
// registered to a different restaurant.
test("a restaurant with no printer is flagged", () => {
  const s = { ...healthy, restaurantsWithoutDevice: [{ id: "r9", name: "Depot Bar and Grill" }] };
  const [i] = evaluateHealth(s, NOW);
  assert.match(i.title, /No printer: Depot Bar and Grill/);
  assert.match(i.detail, /never printed/);
});

test("a ticket stuck in the queue is critical", () => {
  const s = { ...healthy, pendingJobs: [{ id: "j1", order_number: "1195", restaurant_name: "China One", queued_at: minsAgo(20), status: "queued", attempts: 0 }] };
  const [i] = evaluateHealth(s, NOW);
  assert.match(i.title, /Ticket not printed: order 1195/);
});

test("a ticket queued moments ago is not flagged", () => {
  const s = { ...healthy, pendingJobs: [{ id: "j1", order_number: "1195", restaurant_name: "China One", queued_at: minsAgo(1), status: "queued", attempts: 0 }] };
  assert.equal(evaluateHealth(s, NOW).length, 0);
});

test("a ticket that gave up after retries is reported with its error", () => {
  const s = { ...healthy, failedJobs: [{ id: "j2", order_number: "1196", restaurant_name: "China One", error: 'ePOS code="SchemaError"' }] };
  const [i] = evaluateHealth(s, NOW);
  assert.match(i.detail, /SchemaError/);
});

console.log("issue identity and ordering:");

test("keys are stable across runs, so a repeat is not re-alerted", () => {
  const s = { ...healthy, devices: [{ ...healthy.devices[0], last_seen_at: minsAgo(30) }] };
  const a = evaluateHealth(s, NOW)[0].key;
  const b = evaluateHealth(s, new Date(NOW.getTime() + 60000))[0].key;
  assert.equal(a, b, "the same problem must keep the same key as time passes");
});

test("keys distinguish two printers with the same problem", () => {
  const s = {
    ...healthy,
    devices: [
      { id: "d1", name: "P1", restaurant_id: "ra", restaurant_name: "A", is_active: true, last_seen_at: minsAgo(30) },
      { id: "d2", name: "P2", restaurant_id: "rb", restaurant_name: "B", is_active: true, last_seen_at: minsAgo(30) },
    ],
  };
  const keys = evaluateHealth(s, NOW).map((i) => i.key);
  assert.equal(new Set(keys).size, 2);
});

test("critical issues sort ahead of warnings", () => {
  const s = {
    ...healthy,
    devices: [{ ...healthy.devices[0], last_seen_at: minsAgo(30) }],
    restaurantsWithoutDevice: [{ id: "r9", name: "Depot" }],
  };
  const sorted = sortIssues(evaluateHealth(s, NOW));
  assert.equal(sorted[0].severity, "critical");
  assert.equal(sorted[sorted.length - 1].severity, "warning");
});

test("a malformed timestamp does not crash or silently pass", () => {
  const s = { ...healthy, devices: [{ ...healthy.devices[0], last_seen_at: "not-a-date" }] };
  const issues = evaluateHealth(s, NOW);
  assert.equal(issues.length, 1, "unreadable last_seen must be treated as never seen");
  assert.match(issues[0].key, /device_never_seen/);
});

console.log("inbound webhook:");
{
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

  test("a webhook that has never delivered is not flagged", () => {
    // Before go-live, silence is the expected state. Alerting on it nightly
    // would train someone to ignore the channel before it ever matters.
    const s = { ...healthy, webhook: { lastReceiptAt: null, lastAcceptedAt: null, recentTotal: 0, recentRejected: 0, recentWindowHours: 6, recentRejectedSources: [] } };
    assert.deepEqual(evaluateHealth(s, NOW), []);
  });

  test("receipts arriving and ALL being rejected is critical", () => {
    // The 2026-08-27 case: two POSTs, no orders, and nothing able to tell
    // that apart from nobody sending.
    const s = { ...healthy, webhook: { lastReceiptAt: minsAgo(10), lastAcceptedAt: hoursAgo(30), recentTotal: 2, recentRejected: 2, recentWindowHours: 6, recentRejectedSources: [] } };
    const issues = evaluateHealth(s, NOW);
    const i = issues.find((x) => x.key === "webhook_all_rejected");
    assert.ok(i, "must flag a webhook refusing everything");
    assert.equal(i!.severity, "critical");
    assert.match(i!.title, /2 received, 0 accepted/);
  });

  test("a total refusal names the reason it already holds", () => {
    // 2026-09-15: this fired on the CRM's Devices page with "check
    // webhook_receipts for the reason" - and the dashboard the reader would
    // need is one nobody in the office has open. The snapshot had the
    // reasons the whole time.
    const s = {
      ...healthy,
      webhook: {
        lastReceiptAt: minsAgo(10), lastAcceptedAt: hoursAgo(30), recentTotal: 2, recentRejected: 2, recentWindowHours: 6,
        recentRejectedSources: [{ label: "zuppler_restaurant_id 32770", count: 2 }],
      },
    };
    const i = evaluateHealth(s, NOW).find((x) => x.key === "webhook_all_rejected");
    assert.ok(i);
    assert.match(i!.detail, /Reason: zuppler_restaurant_id 32770 \(2\)/);
    assert.doesNotMatch(i!.detail, /Check webhook_receipts/);
  });

  test("a partial rejection is not flagged as total failure", () => {
    // One unmapped restaurant among live traffic is a different, quieter
    // problem than the pipe being shut.
    const s = { ...healthy, webhook: { lastReceiptAt: minsAgo(10), lastAcceptedAt: minsAgo(10), recentTotal: 5, recentRejected: 2, recentWindowHours: 6, recentRejectedSources: [] } };
    assert.equal(evaluateHealth(s, NOW).find((x) => x.key === "webhook_all_rejected"), undefined);
  });

  test("receipts that have never once been accepted is critical", () => {
    const s = { ...healthy, webhook: { lastReceiptAt: minsAgo(10), lastAcceptedAt: null, recentTotal: 0, recentRejected: 0, recentWindowHours: 6, recentRejectedSources: [] } };
    const i = evaluateHealth(s, NOW).find((x) => x.key === "webhook_never_accepted");
    assert.ok(i);
    assert.equal(i!.severity, "critical");
  });

  test("silence past the threshold is a warning, not a critical", () => {
    // Nobody should be woken because a restaurant had a slow Tuesday.
    const s = { ...healthy, webhook: { lastReceiptAt: hoursAgo(30), lastAcceptedAt: hoursAgo(30), recentTotal: 0, recentRejected: 0, recentWindowHours: 6, recentRejectedSources: [] } };
    const i = evaluateHealth(s, NOW).find((x) => x.key === "webhook_silent");
    assert.ok(i, "must flag a pipe with no orders for over a day");
    assert.equal(i!.severity, "warning");
  });

  test("silence just under the threshold is not flagged", () => {
    const s = { ...healthy, webhook: { lastReceiptAt: hoursAgo(23), lastAcceptedAt: hoursAgo(23), recentTotal: 0, recentRejected: 0, recentWindowHours: 6, recentRejectedSources: [] } };
    assert.equal(evaluateHealth(s, NOW).find((x) => x.key === "webhook_silent"), undefined);
  });

  test("an overnight gap does not fire", () => {
    // 10pm close to 8am open is 10 hours of legitimate quiet.
    const s = { ...healthy, webhook: { lastReceiptAt: hoursAgo(10), lastAcceptedAt: hoursAgo(10), recentTotal: 0, recentRejected: 0, recentWindowHours: 6, recentRejectedSources: [] } };
    assert.deepEqual(evaluateHealth(s, NOW), []);
  });
}

console.log("no-printer at channel scale:");
{
  // Mapping the delivery channel brings in hundreds of restaurants that will
  // never print. The alert must stay a short list of real gaps.
  test("a no-printer issue is a WARNING, never a critical", () => {
    const s2 = { ...healthy, restaurantsWithoutDevice: [{ id: "r1", name: "Torinos" }] };
    const i = evaluateHealth(s2, NOW).find((x) => x.key.startsWith("restaurant_no_device"));
    assert.ok(i);
    assert.equal(i!.severity, "warning", "must never page anyone");
  });

  test("warnings alone never produce a text", async () => {
    // SMS is criticals-only; this is what keeps 38 mapped restaurants quiet.
    const { composeSmsAlert } = await import("@/lib/alerts");
    const warnings = Array.from({ length: 38 }, (_, n) => ({
      key: `restaurant_no_device:${n}`, severity: "warning" as const,
      title: `No printer: Restaurant ${n}`, detail: "x",
    }));
    assert.equal(composeSmsAlert(warnings), null);
  });
}

console.log("money reconciliation tripwire:");
{
  test("balanced orders raise nothing", () =>
    assert.equal(evaluateHealth(healthy, NOW).find(i => i.key === "orders_unreconciled"), undefined));

  test("an unexplained gap is a WARNING naming the largest one", () => {
    const s2 = { ...healthy, unreconciledOrders: [
      { id: "o1", order_number: "abc123", restaurant_name: "Torino's", variance: -6.79 },
      { id: "o2", order_number: "def456", restaurant_name: "Ichiban", variance: -1.99 },
    ]};
    const i = evaluateHealth(s2, NOW).find(x => x.key === "orders_unreconciled");
    assert.ok(i);
    assert.equal(i!.severity, "warning", "money arithmetic must never page anyone at 3am");
    assert.match(i!.title, /2 order/);
    assert.match(i!.detail, /\$6\.79/, "must name the LARGEST gap, not the first");
    assert.match(i!.detail, /Torino's/);
  });
}

console.log("email delivery leg:");
{
  const job = (over: Partial<any> = {}) => ({
    id: "j1", order_number: "134d542b", restaurant_name: "Greek Style Gyro",
    queued_at: minsAgo(DEFAULT_THRESHOLDS.emailUnsentMinutes + 1),
    send_error: null, ...over,
  });

  test("an email ticket that never sent is CRITICAL", () => {
    // For an AEM restaurant the email IS the ticket - no queued job waits on
    // a printer that might come back, and nobody there sees anything.
    const s2 = { ...healthy, unsentEmailJobs: [job()] };
    const i = evaluateHealth(s2, NOW).find(x => x.key === "email_send_failed");
    assert.ok(i, "must be raised");
    assert.equal(i!.severity, "critical", "this pages, like a printer going offline");
  });

  test("it names the order, the restaurant, and how long", () => {
    const i = evaluateHealth({ ...healthy, unsentEmailJobs: [job()] }, NOW)
      .find(x => x.key === "email_send_failed")!;
    assert.match(i.detail, /134d542b/);
    assert.match(i.detail, /Greek Style Gyro/);
    assert.match(i.detail, /nobody there has seen this order/);
  });

  test("a send error is surfaced when there is one", () => {
    const i = evaluateHealth({ ...healthy, unsentEmailJobs: [job({ send_error: "invalid_grant" })] }, NOW)
      .find(x => x.key === "email_send_failed")!;
    assert.match(i.detail, /invalid_grant/);
  });

  test("a just-queued email is NOT flagged", () => {
    // The send is synchronous with ingest; a few seconds is normal.
    const s2 = { ...healthy, unsentEmailJobs: [job({ queued_at: minsAgo(1) })] };
    assert.equal(evaluateHealth(s2, NOW).find(x => x.key === "email_send_failed"), undefined);
  });

  test("the threshold boundary is not off by one", () => {
    const under = { ...healthy, unsentEmailJobs: [job({ queued_at: minsAgo(DEFAULT_THRESHOLDS.emailUnsentMinutes - 1) })] };
    const over  = { ...healthy, unsentEmailJobs: [job({ queued_at: minsAgo(DEFAULT_THRESHOLDS.emailUnsentMinutes) })] };
    assert.equal(evaluateHealth(under, NOW).find(x => x.key === "email_send_failed"), undefined);
    assert.ok(evaluateHealth(over, NOW).find(x => x.key === "email_send_failed"));
  });

  test("it reports the OLDEST unsent, not the first in the list", () => {
    const s2 = { ...healthy, unsentEmailJobs: [
      job({ id: "recent", order_number: "newer", queued_at: minsAgo(10) }),
      job({ id: "old", order_number: "older", queued_at: minsAgo(90) }),
    ]};
    const i = evaluateHealth(s2, NOW).find(x => x.key === "email_send_failed")!;
    assert.match(i.title, /2 ticket/);
    assert.match(i.detail, /older/, "the longest-waiting order is the one to name");
  });

  test("an email restaurant never trips the no-printer warning", async () => {
    // It has no printer by design; warning about that would be noise
    // forever, and noise is how a monitoring surface stops being read.
    const src = await import("fs").then(fs => fs.readFileSync("lib/health.ts", "utf8"));
    assert.match(src, /print_method !== "email"/);
  });

  test("a critical email failure DOES produce a text", async () => {
    const { composeSmsAlert } = await import("@/lib/alerts");
    const i = evaluateHealth({ ...healthy, unsentEmailJobs: [job()] }, NOW)
      .find(x => x.key === "email_send_failed")!;
    assert.ok(composeSmsAlert([i]), "criticals must reach a phone");
  });
}

console.log("partial webhook rejection (the blind spot that cost 1,996 orders):");

const partial = (
  total: number,
  rejected: number,
  sources: { label: string; count: number }[] = []
) => ({
  ...healthy,
  webhook: {
    lastReceiptAt: minsAgo(10),
    lastAcceptedAt: minsAgo(10),
    recentTotal: total,
    recentRejected: rejected,
    recentWindowHours: 6,
    recentRejectedSources: sources,
  },
});

const TORINOS = [{ label: "zuppler_restaurant_id 32770", count: 40 }];

test("a mostly-rejecting webhook is flagged even while some succeed", () => {
  // The exact shape of the miss: 72% refused, 28% accepted, and every
  // pre-existing branch satisfied.
  const i = evaluateHealth(partial(100, 72, TORINOS), NOW)
    .find((x) => x.key === "webhook_partial_rejected");
  assert.ok(i, "must flag a webhook refusing a sustained share of arrivals");
  assert.equal(i!.severity, "critical");
});

test("the finding names the offending listing, not just a count", () => {
  // An alert that says "72 rejected" sends you to the SQL editor. One that
  // says which listing is the difference between acting and investigating.
  const i = evaluateHealth(partial(100, 72, TORINOS), NOW)
    .find((x) => x.key === "webhook_partial_rejected")!;
  assert.match(i.detail, /32770/);
});

test("a few refusals inside a healthy stream stay quiet", () => {
  // Below the count floor. A late cancellation for an order we never saw is
  // ordinary, and alerting on it is how a channel gets muted.
  const s = partial(100, 4, [{ label: "zuppler_restaurant_id 999", count: 4 }]);
  assert.equal(
    evaluateHealth(s, NOW).find((x) => x.key === "webhook_partial_rejected"),
    undefined
  );
});

test("a tiny sample with a high share still needs the count floor", () => {
  // 3 of 6 is 50%, but three receipts is not evidence of anything.
  assert.equal(
    evaluateHealth(partial(6, 3), NOW).find((x) => x.key === "webhook_partial_rejected"),
    undefined
  );
});

test("a total outage raises one finding, not two", () => {
  const keys = evaluateHealth(partial(20, 20), NOW).map((x) => x.key);
  assert.ok(keys.includes("webhook_all_rejected"), "total refusal is its own finding");
  assert.ok(!keys.includes("webhook_partial_rejected"), "one problem, one alert");
});

test("rejected orders reach a phone", async () => {
  const { composeSmsAlert } = await import("@/lib/alerts");
  const i = evaluateHealth(partial(100, 72, TORINOS), NOW)
    .find((x) => x.key === "webhook_partial_rejected")!;
  assert.ok(composeSmsAlert([i]), "lost orders must reach a phone");
});


console.log(
  process.exitCode
    ? "\nSOME TESTS FAILED"
    : `\nAll assertions passed (${passed} checks).`
);

console.log("\nthe issues feed carries where (E2):");

test("a keyed issue names its restaurant and, for a printer, its device", () => {
  const s = {
    ...healthy,
    devices: [{ id: "d9", name: "P9", restaurant_id: "r9", restaurant_name: "Nine", is_active: true, last_seen_at: minsAgo(60) }],
    restaurantsWithoutAppDevice: [{ id: "r8", name: "Eight" }],
  };
  const issues = evaluateHealth(s, NOW);
  const printer = issues.find((i) => i.key === "device_silent:d9");
  assert.ok(printer);
  assert.equal(printer!.restaurant_id, "r9");
  assert.equal(printer!.device_id, "d9");
  const tablet = issues.find((i) => i.key === "restaurant_no_app_device:r8");
  assert.ok(tablet);
  assert.equal(tablet!.restaurant_id, "r8");
  assert.equal(tablet!.device_id, undefined);
});

test("the feed route maps restaurant to CRM account, reads resolutions from the record, and honours since", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const route = src("app/api/crm/issues/route.ts");
  assert.match(route, /crm_restaurant_id: i\.restaurant_id \? \(crmIdOf\.get\(i\.restaurant_id\) \?\? null\) : null/);
  assert.match(route, /\.not\("resolved_at", "is", null\)/);
  assert.match(route, /searchParams\.get\("since"\)/);
  assert.match(route, /!i\.first_seen_at \|\| new Date\(i\.first_seen_at\) >= since/, "unstamped issues are always new");
  assert.doesNotMatch(route, /\.update\(|\.insert\(|\.upsert\(/, "the feed reads the record; only the monitor writes it");
  assert.match(src("docs/crm-bridge-contract.md"), /### The issues feed \(E2\)/);
});

console.log("\nan order nobody accepted (Nick, 2026-09-15: three minutes):");

test("three minutes unaccepted is critical, keyed on the order, naming the restaurant", () => {
  const s = {
    ...healthy,
    unacceptedOrders: [
      { id: "o-late", order_number: "1042", restaurant_id: "r1", restaurant_name: "Willie Mae's", received_at: minsAgo(3) },
      { id: "o-fresh", order_number: "1043", restaurant_id: "r1", restaurant_name: "Willie Mae's", received_at: minsAgo(2) },
    ],
  };
  const issues = evaluateHealth(s, NOW);
  const late = issues.find((i) => i.key === "order_unaccepted:o-late");
  assert.ok(late, "three minutes is the line");
  assert.equal(late!.severity, "critical");
  assert.equal(late!.restaurant_id, "r1");
  assert.match(late!.title, /Order not opened: #1042 at Willie Mae's/);
  assert.match(late!.detail, /Call the kitchen/);
  assert.equal(issues.find((i) => i.key === "order_unaccepted:o-fresh"), undefined, "two minutes is not");
});

test("the threshold is three minutes - before the card goes red, so the call is what stops it going red", async () => {
  assert.equal(DEFAULT_THRESHOLDS.orderUnacceptedMinutes, 3);
  const { AGE_LATE_MS } = await import("@/lib/order-display");
  assert.ok(DEFAULT_THRESHOLDS.orderUnacceptedMinutes * 60_000 < AGE_LATE_MS, "the dispatcher is told before the kitchen screen shouts");
});

test("the snapshot asks only about customer orders on tablet restaurants, still live, inside the chime window", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const health = readFileSync(new URL("../lib/health.ts", import.meta.url), "utf8");
  const q = health.slice(health.indexOf('.select("id, order_number, restaurant_id, received_at")'), health.indexOf(".limit(500)"));
  assert.match(q, /\.is\("accepted_at", null\)/);
  assert.match(q, /\.not\("status", "in", "\(cancelled,completed\)"\)/);
  assert.match(q, /\.neq\("source", "test"\)/, "a test order has no customer waiting");
  assert.match(q, /6 \* 60 \* 60 \* 1000/, "the chime window");
  const vercel = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
  assert.match(vercel, /"path": "\/api\/monitor\/check",\s*"schedule": "\* \* \* \* \*"/, "checked every minute, so three means three to four");
});
