// 059: plain per-restaurant order numbers (Matt 2026-11-11). The label everyone sees, the ticket header, and the
// kitchen API's swap of order_number for the plain number.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { displayOrderNo, orderSourceRef, withDisplayOrderNo } from "../lib/order-label";
import { buildTicket, toPlainText } from "../lib/ticket";

assert.equal(displayOrderNo({ ticket_no: 12, order_number: "P-AB12CD" }), "12");
assert.equal(displayOrderNo({ ticket_no: null, order_number: "P-AB12CD" }), "P-AB12CD", "an order from before 059 keeps its old number");
assert.equal(displayOrderNo({ order_number: "" }), "?");
assert.equal(orderSourceRef({ ticket_no: 12, order_number: "48211936" }), "48211936");
assert.equal(orderSourceRef({ ticket_no: 12, order_number: "12" }), null, "no Ref line that only repeats the number");
assert.equal(orderSourceRef({ ticket_no: null, order_number: "48211936" }), null);

const [row] = withDisplayOrderNo([{ id: "o1", ticket_no: 7, order_number: "P-XY99ZZ" }]);
assert.deepEqual(row, { id: "o1", ticket_no: 7, order_number: "7", source_ref: "P-XY99ZZ" });

const text = toPlainText(buildTicket({ ticket_no: 3, order_number: "P-AB12CD", ticket_restaurant_name: "Depot", items: [] } as never, 42, {}, { scale: "normal" }), 42);
assert.match(text, /ORDER #3\b/);
assert.match(text, /Ref P-AB12CD/);
assert.doesNotMatch(text, /ORDER #P-AB12CD/);
const old = toPlainText(buildTicket({ order_number: "P-AB12CD", ticket_restaurant_name: "Depot", items: [] } as never, 42, {}, { scale: "normal" }), 42);
assert.match(old, /ORDER #P-AB12CD/);
assert.doesNotMatch(old, /Ref /);

// The trigger: every source gets a number on insert, per restaurant, from 2026-11-12 Central; TEST- orders none.
const sql = readFileSync(new URL("../db/migrations/059_ticket_numbers.sql", import.meta.url), "utf8");
assert.match(sql, /before insert on orders/);
assert.match(sql, /timestamptz '2026-11-12 00:00:00 America\/Chicago'/);
assert.match(sql, /!~\* '\^TEST-'/);
assert.match(sql, /set ticket_counter = ticket_counter \+ 1\s+where id = new\.restaurant_id/);

console.log("order-label: ok");
