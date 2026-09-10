/**
 * Assertions for the tablet app as a delivery destination.
 *
 * Two things are being protected here, and they pull in opposite directions.
 *
 * One: an order that never reached the tablet must be visible. That is the
 * whole reason the destination got a row of its own - a mute tablet used to
 * look exactly like a quiet service.
 *
 * Two: it must not shout. Most restaurants in this database will never use
 * the app, and a check that flagged all of them would bury the printer alerts
 * that already work. The same judgement printer_expected makes, made again.
 */
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLDS, evaluateHealth, type HealthSnapshot } from "@/lib/health";
import { appDeliveryOutcome } from "@/lib/canonical";

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

const NOW = new Date("2026-09-10T12:00:00Z");
const NOW_ISO = NOW.toISOString();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

const quiet: HealthSnapshot = {
  devices: [],
  inboxes: [],
  restaurantsWithoutDevice: [],
  restaurantsWithoutAppDevice: [],
  pendingJobs: [],
  failedJobs: [],
  unreconciledOrders: [],
  unsentEmailJobs: [],
  undeliveredAppAlerts: [],
  webhook: { lastReceiptAt: null, lastAcceptedAt: null, recentTotal: 0, recentRejected: 0 },
};

const alert = (over: Partial<HealthSnapshot["undeliveredAppAlerts"][number]> = {}) => ({
  id: "j1",
  order_number: "1159",
  restaurant_name: "China One",
  queued_at: minsAgo(30),
  send_error: null,
  alsoPrints: false,
  ...over,
});

console.log("recording what happened to a push:");

test("reaching one device is a delivery", () => {
  const o = appDeliveryOutcome({ subscriptions: 2, sent: 1, failed: 1 }, NOW_ISO);
  assert.equal(o.status, "printed");
  assert.equal(o.delivered_count, 1);
  assert.equal(o.sent_at, NOW_ISO, "sent_at is what makes 'never arrived' findable");
  assert.equal(o.send_error, null);
});

test("no subscriptions is named as a setup gap, not a failure to send", () => {
  const o = appDeliveryOutcome({ subscriptions: 0, sent: 0, failed: 0 }, NOW_ISO);
  assert.equal(o.status, "failed");
  assert.equal(o.sent_at, null);
  assert.match(
    o.send_error ?? "",
    /notifications/i,
    "the fix is someone tapping Enable notifications - the message should say so"
  );
});

test("subscriptions that all failed say so, with the count", () => {
  const o = appDeliveryOutcome({ subscriptions: 3, sent: 0, failed: 3 }, NOW_ISO);
  assert.equal(o.status, "failed");
  assert.equal(o.delivered_count, 0);
  assert.match(o.send_error ?? "", /3 push attempt/);
});

test("a send that could not be attempted carries its own reason", () => {
  const o = appDeliveryOutcome(
    { subscriptions: 0, sent: 0, failed: 0, error: "No key set vapidDetails.publicKey" },
    NOW_ISO
  );
  assert.equal(o.status, "failed");
  assert.match(o.send_error ?? "", /vapidDetails/, "the real cause must survive to the row");
});

test("a partial delivery is still a delivery", () => {
  // Four tablets, one flat battery. The order reached the restaurant.
  const o = appDeliveryOutcome({ subscriptions: 4, sent: 3, failed: 1 }, NOW_ISO);
  assert.equal(o.status, "printed");
  assert.equal(o.delivered_count, 3);
});

console.log("\nalerting on a tablet that did not get the order:");

test("a quiet system produces no issues", () =>
  assert.deepEqual(evaluateHealth(quiet, NOW), []));

test("an undelivered alert under the threshold is not flagged", () => {
  const s = {
    ...quiet,
    undeliveredAppAlerts: [alert({ queued_at: minsAgo(DEFAULT_THRESHOLDS.appUndeliveredMinutes - 1) })],
  };
  assert.equal(evaluateHealth(s, NOW).length, 0, "the push is seconds old - do not cry wolf");
});

test("no paper ticket to fall back on is critical", () => {
  const issues = evaluateHealth({ ...quiet, undeliveredAppAlerts: [alert()] }, NOW);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "app_alert_failed");
  assert.equal(issues[0].severity, "critical");
  assert.match(issues[0].detail, /nobody there has seen the order/i);
});

test("a ticket that also printed downgrades it to a warning", () => {
  const issues = evaluateHealth(
    { ...quiet, undeliveredAppAlerts: [alert({ alsoPrints: true })] },
    NOW
  );
  assert.equal(issues.length, 1);
  assert.equal(
    issues[0].severity,
    "warning",
    "the kitchen has the order on paper - this must not page someone at 7pm"
  );
  assert.match(issues[0].detail, /ticket did print/i);
});

test("one blind restaurant in a batch makes the whole alert critical", () => {
  const issues = evaluateHealth(
    {
      ...quiet,
      undeliveredAppAlerts: [
        alert({ id: "j1", alsoPrints: true }),
        alert({ id: "j2", alsoPrints: false, restaurant_name: "Swezey's Pub" }),
      ],
    },
    NOW
  );
  assert.equal(issues[0].severity, "critical");
  assert.match(
    issues[0].detail,
    /Swezey's Pub/,
    "the example named should be the restaurant nobody has told, not the covered one"
  );
});

test("the send_error is carried into the alert", () => {
  const issues = evaluateHealth(
    { ...quiet, undeliveredAppAlerts: [alert({ send_error: "no device has notifications enabled" })] },
    NOW
  );
  assert.match(issues[0].detail, /notifications enabled/);
});

test("a restaurant on the app with no subscriptions is a warning, not a page", () => {
  const issues = evaluateHealth(
    { ...quiet, restaurantsWithoutAppDevice: [{ id: "r1", name: "China One" }] },
    NOW
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "restaurant_no_app_device:r1");
  assert.equal(issues[0].severity, "warning");
  assert.match(issues[0].detail, /Enable notifications/);
});

test("alert keys are stable, so a standing problem is not re-announced", () => {
  const s = { ...quiet, undeliveredAppAlerts: [alert()] };
  assert.deepEqual(
    evaluateHealth(s, NOW).map((i) => i.key),
    evaluateHealth(s, new Date(NOW.getTime() + 3600_000)).map((i) => i.key)
  );
});

console.log(`\n${passed} assertions passed.`);
