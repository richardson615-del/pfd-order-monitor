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
  devices: [{ id: "d1", name: "Kitchen printer", restaurant_name: "China One", is_active: true, last_seen_at: minsAgo(0) }],
  inboxes: [{ id: "i1", email_address: "a@b.com", restaurant_name: "China One", is_active: true, has_token: true, last_poll_at: minsAgo(1) }],
  restaurantsWithoutDevice: [],
  pendingJobs: [],
  failedJobs: [],
  webhook: {
    lastReceiptAt: minsAgo(5),
    lastAcceptedAt: minsAgo(5),
    recentTotal: 3,
    recentRejected: 0,
  },
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
      { id: "d1", name: "P1", restaurant_name: "A", is_active: true, last_seen_at: minsAgo(30) },
      { id: "d2", name: "P2", restaurant_name: "B", is_active: true, last_seen_at: minsAgo(30) },
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
    const s = { ...healthy, webhook: { lastReceiptAt: null, lastAcceptedAt: null, recentTotal: 0, recentRejected: 0 } };
    assert.deepEqual(evaluateHealth(s, NOW), []);
  });

  test("receipts arriving and ALL being rejected is critical", () => {
    // The 2026-08-27 case: two POSTs, no orders, and nothing able to tell
    // that apart from nobody sending.
    const s = { ...healthy, webhook: { lastReceiptAt: minsAgo(10), lastAcceptedAt: hoursAgo(30), recentTotal: 2, recentRejected: 2 } };
    const issues = evaluateHealth(s, NOW);
    const i = issues.find((x) => x.key === "webhook_all_rejected");
    assert.ok(i, "must flag a webhook refusing everything");
    assert.equal(i!.severity, "critical");
    assert.match(i!.title, /2 received, 0 accepted/);
  });

  test("a partial rejection is not flagged as total failure", () => {
    // One unmapped restaurant among live traffic is a different, quieter
    // problem than the pipe being shut.
    const s = { ...healthy, webhook: { lastReceiptAt: minsAgo(10), lastAcceptedAt: minsAgo(10), recentTotal: 5, recentRejected: 2 } };
    assert.equal(evaluateHealth(s, NOW).find((x) => x.key === "webhook_all_rejected"), undefined);
  });

  test("receipts that have never once been accepted is critical", () => {
    const s = { ...healthy, webhook: { lastReceiptAt: minsAgo(10), lastAcceptedAt: null, recentTotal: 0, recentRejected: 0 } };
    const i = evaluateHealth(s, NOW).find((x) => x.key === "webhook_never_accepted");
    assert.ok(i);
    assert.equal(i!.severity, "critical");
  });

  test("silence past the threshold is a warning, not a critical", () => {
    // Nobody should be woken because a restaurant had a slow Tuesday.
    const s = { ...healthy, webhook: { lastReceiptAt: hoursAgo(30), lastAcceptedAt: hoursAgo(30), recentTotal: 0, recentRejected: 0 } };
    const i = evaluateHealth(s, NOW).find((x) => x.key === "webhook_silent");
    assert.ok(i, "must flag a pipe with no orders for over a day");
    assert.equal(i!.severity, "warning");
  });

  test("silence just under the threshold is not flagged", () => {
    const s = { ...healthy, webhook: { lastReceiptAt: hoursAgo(23), lastAcceptedAt: hoursAgo(23), recentTotal: 0, recentRejected: 0 } };
    assert.equal(evaluateHealth(s, NOW).find((x) => x.key === "webhook_silent"), undefined);
  });

  test("an overnight gap does not fire", () => {
    // 10pm close to 8am open is 10 hours of legitimate quiet.
    const s = { ...healthy, webhook: { lastReceiptAt: hoursAgo(10), lastAcceptedAt: hoursAgo(10), recentTotal: 0, recentRejected: 0 } };
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

console.log(
  process.exitCode
    ? "\nSOME TESTS FAILED"
    : `\nAll assertions passed (${passed} checks).`
);
