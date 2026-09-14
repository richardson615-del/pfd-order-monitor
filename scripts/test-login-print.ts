/**
 * Assertions for printing a restaurant's tablet login on its own Epson.
 *
 * Two things are being protected here, and they pull in opposite directions.
 *
 * One: this prints a PASSWORD on paper in a kitchen. The refusals have to
 * happen in the right order and the route must not be able to print a login
 * that belongs to somebody else, or onto somebody else's printer.
 *
 * Two: it must not break the path that carries food. A document job is a new
 * shape in print_jobs, and the Epson endpoint and the on-site agent both read
 * that table - one of them has never heard of documents.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLoginTicket, SETUP_STEPS } from "../lib/print-document";

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
const route = src("app/api/crm/restaurants/[id]/logins/print/route.ts");
const epson = src("app/api/print/epson/route.ts");
const agent = src("app/api/print/jobs/route.ts");
const migration = src("db/migrations/029_print_documents.sql");

const ticket = () =>
  buildLoginTicket({
    restaurantName: "Swezey's",
    username: "swezeys",
    password: "Kite-Fern-7742",
    appUrl: "https://pfd-order-monitor.vercel.app",
    actor: "nick@pfdworks.com",
    includeSetupSteps: true,
    rotated: false,
    now: new Date("2026-09-14T15:00:00Z"),
  });

const textOf = (lines: { text: string }[]) => lines.map((l) => l.text).join("\n");

console.log("the ticket says what it is, and what to do with it:");

test("it is headed as a login, not left as an anonymous slip of paper", () => {
  const first = ticket()[0];
  assert.match(first.text, /T A B L E T {3}L O G I N/);
  assert.equal(first.reverse, true, "the heading uses the same emphasis as the order ticket's");
});

test("it carries the restaurant, the app address, the username and the password", () => {
  const text = textOf(ticket());
  assert.match(text, /Swezey's/);
  assert.match(text, /pfd-order-monitor\.vercel\.app/);
  assert.match(text, /swezeys/);
  assert.match(text, /Kite-Fern-7742/);
});

test("the password is never wrapped", () => {
  // A password broken across two lines is a password typed wrong.
  const long = buildLoginTicket({
    restaurantName: "A restaurant with quite a long name indeed",
    username: "areallyquitelongusername",
    password: "Correct-Horse-Battery-Staple-And-Then-Some-More",
    appUrl: "https://pfd-order-monitor.vercel.app",
    actor: null,
    includeSetupSteps: true,
    rotated: false,
  });
  assert.ok(
    long.some((l) => l.text === "Correct-Horse-Battery-Staple-And-Then-Some-More"),
    "the password must appear on exactly one line, whole"
  );
});

test("a long credential drops to double height rather than running off the paper", () => {
  const long = buildLoginTicket({
    restaurantName: "X", username: "u",
    password: "Correct-Horse-Battery-Staple-And-Then-Some-More",
    appUrl: "https://x.test", actor: null, includeSetupSteps: false, rotated: false,
  });
  const line = long.find((l) => l.text.startsWith("Correct-Horse"))!;
  // Double WIDTH halves the columns; at 47 characters this would clip.
  assert.equal(line.size, "double-h");
  const short = ticket().find((l) => l.text === "Kite-Fern-7742")!;
  assert.equal(short.size, "double");
});

test("the setup steps are in the order they must be done, notifications included", () => {
  const text = textOf(ticket());
  // Numbered and in order. Compared on the first few words rather than the
  // whole step: a step longer than the paper is wrapped, which is correct
  // behaviour and should not read as a missing step.
  SETUP_STEPS.forEach((step, i) => {
    assert.ok(text.includes(`${i + 1}. ${step.split(" ").slice(0, 3).join(" ")}`), step);
  });
  // A tablet signed in but never subscribed looks completely set up and
  // receives nothing. It is the most expensive way this deployment fails.
  //
  // "Turn on alerts" since the app stopped making that optional - the ticket
  // has to name the button the person is actually looking for.
  assert.match(text, /Turn on alerts/);
  assert.ok(
    text.indexOf("Sign in with") < text.indexOf("Turn on alerts"),
    "sign in comes before turning alerts on"
  );
});

test("the steps can be left off without losing the credentials", () => {
  const bare = buildLoginTicket({
    restaurantName: "X", username: "u", password: "p",
    appUrl: "https://x.test", actor: null, includeSetupSteps: false, rotated: false,
  });
  const text = textOf(bare);
  assert.doesNotMatch(text, /Turn on alerts/);
  assert.match(text, /Username:/);
  assert.match(text, /Password:/);
});

test("a rotated password says so on the paper", () => {
  const rotated = buildLoginTicket({
    restaurantName: "X", username: "u", password: "p",
    appUrl: "https://x.test", actor: null, includeSetupSteps: false, rotated: true,
  });
  // Matched in two pieces: the sentence is wrapped to the paper width, so a
  // single regex across it is asserting where the line breaks fall.
  assert.match(textOf(rotated), /NEW password/);
  assert.match(textOf(rotated).replace(/\n/g, " "), /previous one stopped working/);
  assert.doesNotMatch(textOf(ticket()), /NEW password/);
});

test("it names who sent it, and warns that it is a credential", () => {
  const text = textOf(ticket());
  assert.match(text, /Sent by nick@pfdworks\.com/);
  assert.match(text, /somewhere private/);
});

console.log("\nwho it can print, and where:");

test("the login must belong to this restaurant", () => {
  // Same rule, and the same reason, as the logins route's own PATCH: a
  // restaurant-scoped call must not act on a login elsewhere in the system
  // just because the username was spelled right.
  assert.match(route, /findLink\(restaurant\.id, username\)/);
  assert.match(route, /login_not_found/);
});

test("the printer must belong to this restaurant", () => {
  assert.match(route, /device\.restaurant_id !== restaurantId/);
  assert.match(route, /device_not_for_restaurant/);
});

test("a password that was never stored is refused as its own case", () => {
  // Pre-026 logins have only Supabase's hash. The CRM needs to tell this
  // apart from a failure so it can offer "new password" instead.
  assert.match(route, /password_unavailable/);
  assert.match(route, /resettable: true/);
});

test("a restaurant with no active printer is refused, not defaulted to somebody else's", () => {
  assert.match(route, /no_active_printer/);
  assert.match(route, /\.eq\("restaurant_id", restaurantId\)[\s\S]*\.eq\("is_active", true\)/);
});

test("the printer is chosen BEFORE the password is rotated", () => {
  // Rotating and then finding nowhere to print leaves a restaurant locked out
  // with the only copy of the new password on a screen in another state.
  const choose = route.indexOf("const chosen = await chooseDevice");
  const rotate = route.indexOf('mode === "reset"', choose === -1 ? 0 : choose);
  const update = route.indexOf("updateUserById");
  assert.ok(choose > -1 && update > -1, "both steps must be present");
  assert.ok(choose < update, "device selection must come before the password write");
  assert.ok(rotate > -1);
});

test("every print is audited, and a rotation audits twice", () => {
  assert.match(route, /action: "password_printed"/);
  assert.match(route, /action: "password_reset"/);
});

test("the audit table will actually accept the new action", () => {
  // audit() never fails the request it records, by design. So a CHECK that
  // rejects 'password_printed' would not break anything visibly - it would
  // just mean every login print happens with no audit row, reported only in a
  // Vercel log nobody reads. Which is worse than not auditing on purpose.
  assert.match(migration, /restaurant_login_audit_action_check/);
  assert.match(migration, /'created', 'password_reset', 'password_shown', 'password_printed'/);
});

test("an offline printer is queued for, not refused", () => {
  // The usual reason to print a login is that somebody is at the restaurant
  // setting the thing up. Refusing an unplugged printer refuses the case.
  assert.match(route, /device_last_seen_at/);
  assert.doesNotMatch(route, /printer_offline/);
});

test("a device that prints through the on-site agent is refused with a reason", () => {
  assert.match(route, /printer_not_supported/);
  assert.match(route, /SERVER_DIRECT_PRINT/);
});

console.log("\nit does not disturb the path that carries food:");

test("no fake order is written", () => {
  // test_print writes one deliberately. A credential must not: an orders row
  // shows on the restaurant's own screens, is counted by health checks, and
  // is kept out of accounting by exactly one `.neq("source","test")` filter.
  assert.doesNotMatch(route, /\.from\("orders"\)/);
  assert.doesNotMatch(route, /source: "test"/);
});

test("a document job carries no order, and an order job carries no document", () => {
  assert.match(migration, /alter table print_jobs alter column order_id drop not null/);
  assert.match(migration, /print_jobs_payload_check/);
  assert.match(migration, /kind = 'order' and order_id is not null and document is null/);
  assert.match(migration, /kind = 'document' and document is not null and order_id is null/);
});

test("the same login can be printed twice", () => {
  // print_jobs has `unique (order_id, device_id)` from migration 002, written
  // about orders. Postgres treats NULLs as distinct in a unique index unless
  // told otherwise, so two document jobs to one printer do not collide -
  // which is load-bearing, because people WILL print a login twice.
  assert.match(migration, /NULLS NOT DISTINCT/);
  assert.match(migration, /Do not add NULLS NOT DISTINCT here/);
});

test("the Epson endpoint still prints orders, and now also prints documents", () => {
  assert.match(epson, /j\.orders \|\| Array\.isArray\(j\.document\)/);
  assert.match(epson, /Array\.isArray\(job\.document\)/);
  // The order branch must still be reached - the document check returns early
  // only for documents.
  assert.match(epson, /const r = job\.orders\?\.restaurants;/);
});

test("a login ticket carries none of the restaurant's branding", () => {
  // renderHeader names the restaurant as though this were their food, and the
  // footer would put "Scan to order again" underneath a password.
  const documentBranch = epson.slice(
    epson.indexOf("Array.isArray(job.document)"),
    epson.indexOf("const r = job.orders?.restaurants;")
  );
  assert.doesNotMatch(documentBranch, /renderHeader|renderFooter|toEposImageXml/);
});

test("the on-site agent is never handed a document it cannot draw", () => {
  assert.match(agent, /\.eq\("kind", "order"\)/);
  // ...and reporting one printed must not try to flip an order that is not there.
  assert.match(agent, /if \(job\.order_id\) \{/);
});

console.log(`\n${passed} assertions passed.`);
