/**
 * Assertions for printing an order on demand.
 *
 * Two surfaces, one queue: the Print button on the tablet, and the CRM's test
 * order. What is being protected is mostly not the happy path - it is the
 * three things that make an on-demand reprint different from the ingest path
 * it borrows from:
 *
 *   - authorisation, because a reprint takes an ORDER ID from a browser;
 *   - the unique (order_id, device_id) constraint, which makes a second print
 *     of the same order an UPDATE rather than an insert;
 *   - and saying "queued" rather than "printed", because the printer has not
 *     moved yet when the response goes out.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const queue = src("lib/print-queue.ts");
const route = src("app/api/orders/[id]/print/route.ts");
const viewer = src("components/OrderViewer.tsx");

console.log("who may reprint what:");

test("the order is read through the CALLER's session, not the service role", () => {
  // RLS is the authorisation check. Reading as admin and filtering by hand is
  // how a cross-restaurant reprint gets shipped by accident.
  assert.match(route, /supabaseServer\(\)/);
  const read = route.slice(route.indexOf("const { data: order }"), route.indexOf("queueOrderToPrinters"));
  assert.doesNotMatch(read, /supabaseAdmin/, "the order lookup must not use the service role");
});

test("not-found and not-yours are one answer", () => {
  // Distinguishing them leaks which order ids exist.
  assert.match(route, /order not found/);
  assert.match(route, /status: 404/);
});

test("an unauthenticated call is refused before anything is read", () => {
  const unauth = route.indexOf("status: 401");
  const read = route.indexOf('.from("orders")');
  assert.ok(unauth > -1 && read > -1);
  assert.ok(unauth < read);
});

test("the job itself is written with the service role", () => {
  // Restaurant sessions cannot write print_jobs, and should not be able to.
  assert.match(queue, /supabaseAdmin\(\)/);
});

console.log("\nreprinting is an update, not a second insert:");

test("an existing job for this order and device is re-queued", () => {
  // print_jobs has `unique (order_id, device_id)` from migration 002 - right
  // on ingest ("an order prints once per device"), wrong for a reprint. A
  // second insert fails; the row is moved back to 'queued' instead.
  assert.match(queue, /\.eq\("order_id", orderId\)/);
  assert.match(queue, /status: "queued",\s*claimed_at: null,\s*finished_at: null/);
  assert.match(queue, /requeued: true/);
});

test("the retry budget resets, so a failed job is repaired by the same button", () => {
  // Otherwise a job that had already failed three times comes straight back
  // as failed - and a printer that has just been fixed is the most likely
  // reason somebody is pressing this.
  assert.match(queue, /attempts: 0/);
  assert.match(queue, /error: null/);
});

test("a device with no prior job is inserted normally", () => {
  assert.match(queue, /\.insert\(\{ order_id: orderId, device_id: device\.id \}\)/);
  assert.match(queue, /requeued: false/);
});

console.log("\nwhere it refuses, and why:");

test("an email restaurant is refused with its own reason", () => {
  // Its paper is made by a PC running AEM from an email. A print job there is
  // a row nothing will ever claim.
  assert.match(queue, /email_restaurant/);
  assert.match(queue, /print_method === "email"/);
});

test("inactive printers are not queued to", () => {
  // The bridge rejects an inactive device's poll, so the job waits forever
  // and reads as a hardware fault.
  assert.match(queue, /\.eq\("is_active", true\)/);
  assert.match(queue, /no_active_printer/);
});

test("a refusal is a 409, not a 500 - the request was fine", () => {
  assert.match(route, /status: result\.refusal === "restaurant_not_found" \? 404 : 409/);
});

console.log("\nwhat the tablet says happened:");

test("Print sends to the restaurant's printer rather than the browser dialog", () => {
  // The whole point. window.print() on a kiosk tablet reaches nothing: the
  // Epson is not a system printer, it polls and prints what it is handed.
  assert.match(viewer, /\/api\/orders\/\$\{order\.id\}\/print/);
  assert.match(viewer, /async function sendToPrinter\(\)/);
});

test("there is NO browser print dialog, ever", () => {
  // Reported 2026-09-14: "it gives me options to print to printers on the
  // local wifi but not the epson printer". The Android chooser lists system
  // and network printers, and a Server Direct Print device cannot appear
  // among them - so the dialog is a dead end dressed up as a choice, and the
  // one printer the restaurant owns is the only one missing from it.
  //
  // Comments are stripped first, so the explanation above the handler (which
  // names window.print() to say why it is gone) cannot satisfy the test, and
  // a real call cannot hide behind it either.
  const code = viewer
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /window\.print\(/, "OrderViewer must not call window.print()");
  assert.doesNotMatch(viewer, /print dialog instead/);
});

test("a refusal is stated in words instead", () => {
  // A refusal somebody can read beats a menu that cannot contain the right
  // answer. The bridge's own message is shown, because it names the reason.
  assert.match(viewer, /setPrintNote\(data\.error \?\? "Could not send that to the printer\."\)/);
});

test("it says queued, not printed", () => {
  // The printer has not moved when the response goes out.
  assert.match(route, /Queued\./);
  assert.doesNotMatch(viewer, /Printed on/);
  assert.match(viewer, /It prints in a few seconds/);
});

test("the button cannot be pressed twice while a send is in flight", () => {
  assert.match(viewer, /disabled=\{busy \|\| printing\}/);
});

console.log(`\n${passed} assertions passed.`);
