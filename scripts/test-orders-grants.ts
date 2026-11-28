/**
 * Z-03 (migration 063): a restaurant session may update only status and the
 * order timers, never the money columns the CRM payout feed reads.
 *
 * Reads the migration and asserts the grant list is exactly the status/timer
 * set with no money column, that UPDATE is revoked first and the policy has a
 * WITH CHECK; then reads the two user-scoped writers (session client, RLS) and
 * asserts every column they set is in the grant, so a new client-written
 * column fails here instead of failing on a tablet.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(p, "utf8");
const sql = src("db/migrations/063_orders_column_grants.sql")
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

const grantMatch = sql.match(/grant\s+update\s*\(([^)]*)\)\s*on\s+table\s+orders\s+to\s+authenticated/i);
assert.ok(grantMatch, "063 grants column UPDATE on orders to authenticated");
const granted = new Set(grantMatch![1]!.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean));

const EXPECTED = ["status", "opened_at", "completed_at", "printed_at", "accepted_at", "ready_minutes", "ready_by", "ready_at", "updated_at"];
assert.deepEqual([...granted].sort(), [...EXPECTED].sort(), "grant list is the status/timer set only");

const MONEY = [
  "customer_total", "subtotal", "items_total", "tip", "tax", "discount", "money_variance",
  "service_fee", "delivery_fee", "hidden_fee", "ezcater_fee",
  "items", "raw_payload", "restaurant_id", "order_number", "ticket_no",
];
for (const col of MONEY) assert.ok(!granted.has(col), `${col} is not client-writable`);
for (const col of granted) assert.ok(!col.endsWith("_fee"), `${col}: no *_fee column is client-writable`);

assert.match(sql, /revoke\s+update\s+on\s+table\s+orders\s+from\s+authenticated\s*,\s*anon/i, "table-wide UPDATE revoked from authenticated and anon");
assert.ok(sql.search(/revoke\s+update/i) < sql.search(/grant\s+update/i), "revoke comes before the column grant");
assert.match(sql, /alter\s+policy\s+"orders_update"\s+on\s+orders[\s\S]*with\s+check\s*\(\s*is_admin\(\)\s+or\s+belongs_to_restaurant\(restaurant_id\)\s*\)/i, "orders_update has a WITH CHECK");
assert.doesNotMatch(sql, /grant\s+update[^;]*to\s+anon/i, "anon gets no UPDATE");

// 069 (ED3): the tablet stamps customer_change_seen_at when the "Customer
// details changed" bar is tapped. One column, added on top of 063's list.
const sql069 = src("db/migrations/069_customer_details_update.sql")
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const grants069 = [...sql069.matchAll(/grant\s+update\s*\(([^)]*)\)\s*on\s+table\s+orders\s+to\s+authenticated/gi)];
assert.equal(grants069.length, 1, "069 grants one column UPDATE on orders");
assert.deepEqual(grants069[0]![1]!.split(",").map((c) => c.trim().toLowerCase()), ["customer_change_seen_at"], "069 grants only customer_change_seen_at");
assert.doesNotMatch(sql069, /to\s+anon/i, "069 grants nothing to anon");
granted.add("customer_change_seen_at");

// The session-client writers: every column they set must be granted.
function writtenColumns(file: string): Set<string> {
  const text = src(file);
  const cols = new Set<string>();
  const keysOf = (body: string) => {
    for (const m of body.matchAll(/(?:^|[,{\s])([a-z_]+)\s*:/g)) cols.add(m[1]!);
    for (const m of body.matchAll(/(?:^|[,{\s])([a-z_]+)\s*(?=[,}\s]*$|,)/g)) if (/^[a-z_]+_at$|^status$/.test(m[1]!)) cols.add(m[1]!);
  };
  for (const m of text.matchAll(/\.update\(\s*\{([^}]*)\}/g)) keysOf(m[1]!);
  for (const m of text.matchAll(/const update[^=]*=\s*\{([^}]*)\}/g)) keysOf(m[1]!);
  for (const m of text.matchAll(/update\.([a-z_]+)\s*=/g)) cols.add(m[1]!);
  const tsMap = text.match(/STATUS_TIMESTAMP_COLUMN[^=]*=\s*\{([^}]*)\}/);
  if (tsMap) for (const m of tsMap[1]!.matchAll(/"([a-z_]+)"/g)) cols.add(m[1]!);
  return cols;
}

const route = writtenColumns("app/api/orders/[id]/route.ts");
const page = writtenColumns("app/order/[id]/page.tsx");
for (const c of ["accepted_at", "ready_minutes", "ready_by", "ready_at", "status", "opened_at", "completed_at", "printed_at"]) {
  assert.ok(route.has(c), `route.ts writes ${c} (parser still sees it)`);
}
assert.ok(page.has("opened_at") && page.has("status"), "order page writes opened_at and status");
for (const c of [...route, ...page]) assert.ok(granted.has(c), `user-scoped write to orders.${c} is granted in 063`);

// The two files must still use the session client for these writes (RLS scopes the row).
assert.match(src("app/api/orders/[id]/route.ts"), /const supabase = supabaseServer\(\)/);
assert.match(src("app/order/[id]/page.tsx"), /const supabase = supabaseServer\(\)/);

console.log(`orders grants ok: ${granted.size} client-writable columns, ${MONEY.length} money columns pinned out`);
