/**
 * The menu on the tablet and the edits made there (migration 049).
 *
 * Worth asserting: a CRM push is checked whole (a ref missing anywhere fails
 * it); an edit names its item by ref and becomes exactly the line the CRM's
 * rules parser reads; an edit that changes nothing is refused; "Sent to
 * Premium" is decided by the push time; and, by reading the routes, that the
 * tablet never writes the menu and the CRM never writes without the key.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { filterMenu, findMenuItem, parseMenuEdits, parseMenuPush, parsePriceInput, pendingRefs, type TabletMenu } from "@/lib/menu-editor";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    throw err;
  }
}
const src = (p: string) => readFileSync(p, "utf8");

const push = {
  menu_id: "snap-1",
  source: "zuppler",
  categories: [
    { ref: "c1", name: "Plates", items: [
      { ref: "i1", name: "Rib Plate", price_cents: 2299, available: true, description: "Half slab" },
      { ref: "i2", name: "Brisket Plate", price_cents: 1899, available: false },
    ] },
    { ref: "c2", name: "Desserts", items: [{ ref: "i3", name: "Banana Pudding", price_cents: 499 }] },
  ],
};
const parsed = parseMenuPush(push);
assert.ok(parsed.ok);
const menu: TabletMenu = parsed.ok ? parsed.menu : (null as never);

test("a push is accepted whole and counted", () => {
  assert.equal(parsed.ok && parsed.itemCount, 3);
  assert.equal(findMenuItem(menu, "i3")?.item.available, true, "available defaults to true");
  assert.equal(findMenuItem(menu, "i2")?.category.name, "Plates");
});

test("a push with a hole in it is refused, naming the hole", () => {
  const bad = structuredClone(push) as any;
  delete bad.categories[1].items[0].ref;
  const r = parseMenuPush(bad);
  assert.ok("error" in r && /Desserts item 0: bad ref/.test(r.error));
  const dup = structuredClone(push) as any;
  dup.categories[1].items[0].ref = "i1";
  assert.ok(!parseMenuPush(dup).ok);
  assert.ok(!parseMenuPush({ source: "zuppler", categories: [] }).ok, "menu_id is required");
  assert.ok(!parseMenuPush({ menu_id: "x", categories: [{ ref: "c", name: "C", items: [{ ref: "i", name: "I", price_cents: 12.5 }] }] }).ok, "cents are whole");
});

test("each edit becomes the CRM parser's exact line, by ref", () => {
  const r = parseMenuEdits(
    [
      { ref: "i1", action: "set_price", price_cents: 2499 },
      { ref: "i1", action: "sold_out" },
      { ref: "i2", action: "back_on" },
      { ref: "i3", action: "rename", name: "Nana's Banana Pudding -> yes" },
    ],
    menu
  );
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.menuChanges.lines, ["price #i1 = 24.99", "86 #i1", "un-86 #i2", "rename #i3 -> Nana's Banana Pudding - yes"]);
  assert.equal(r.ok && r.menuChanges.menu_id, "snap-1");
  assert.equal(r.ok && r.body, 'Rib Plate: $22.99 to $24.99\nRib Plate: sold out\nBrisket Plate: back on the menu\nBanana Pudding: renamed to "Nana\'s Banana Pudding - yes"');
});

test("an edit that changes nothing, or names an item not on the menu, is refused", () => {
  assert.match((parseMenuEdits({ ref: "i1", action: "set_price", price_cents: 2299 }, menu) as any).error, /already \$22\.99/);
  assert.match((parseMenuEdits({ ref: "i2", action: "sold_out" }, menu) as any).error, /already marked sold out/);
  assert.match((parseMenuEdits({ ref: "i1", action: "back_on" }, menu) as any).error, /already on the menu/);
  assert.match((parseMenuEdits({ ref: "nope", action: "sold_out" }, menu) as any).error, /isn't on the menu any more/);
  assert.match((parseMenuEdits({ ref: "i1", action: "set_price", price_cents: 0 }, menu) as any).error, /between/);
  assert.match((parseMenuEdits({ ref: "i1", action: "rename", name: "  " }, menu) as any).error, /new name/);
  assert.ok(!parseMenuEdits([], menu).ok);
  assert.ok(!parseMenuEdits({ ref: "i1", action: "delete" }, menu).ok, "the tablet cannot delete");
});

test("a typed price is read the way a kitchen writes it", () => {
  assert.equal(parsePriceInput("24.99"), 2499);
  assert.equal(parsePriceInput("$24.99"), 2499);
  assert.equal(parsePriceInput("24"), 2400);
  assert.equal(parsePriceInput("24.5"), 2450);
  assert.equal(parsePriceInput("0"), null);
  assert.equal(parsePriceInput("abc"), null);
  assert.equal(parsePriceInput("1000"), null);
});

test("Sent to Premium is decided by the push time", () => {
  const changes = { menu_id: "snap-1", lines: ["86 #i1"], changes: [{ ref: "i1", action: "sold_out" as const, item: "Rib Plate", line: "86 #i1", text: "" }] };
  const before = { created_at: "2026-10-06T10:00:00Z", menu_changes: changes };
  const after = { created_at: "2026-10-06T12:00:00Z", menu_changes: changes };
  const typed = { created_at: "2026-10-06T12:30:00Z", menu_changes: null };
  assert.deepEqual([...pendingRefs([before, after, typed], "2026-10-06T11:00:00Z")], ["i1"]);
  assert.deepEqual([...pendingRefs([before], "2026-10-06T11:00:00Z")], []);
});

test("search keeps category order and drops empty categories", () => {
  assert.deepEqual(filterMenu(menu, "plate").map((c) => [c.name, c.items.length]), [["Plates", 2]]);
  assert.deepEqual(filterMenu(menu, "").length, 2);
  assert.deepEqual(filterMenu(menu, "zzz"), []);
});

test("the CRM push needs the key; the tablet routes take the restaurant from the session and never write the menu", () => {
  const crm = src("app/api/crm/restaurants/[id]/menu/route.ts");
  assert.match(crm, /authorizeCrmWrite\(req\)/);
  assert.match(crm, /findRestaurantByRef/);
  for (const p of ["app/api/dashboard/menu/route.ts", "app/api/dashboard/menu/changes/route.ts"]) {
    const s = src(p);
    assert.match(s, /getCurrentUserRestaurantIds/);
    assert.doesNotMatch(s, /restaurant_id:\s*(input|body)\./, `${p} takes the restaurant from the body`);
  }
  const changes = src("app/api/dashboard/menu/changes/route.ts");
  // Every statement on restaurant_menus in the tablet routes is a read.
  for (const p of ["app/api/dashboard/menu/route.ts", "app/api/dashboard/menu/changes/route.ts"]) {
    for (const m of src(p).matchAll(/from\("restaurant_menus"\)([^;]*);/g)) {
      assert.doesNotMatch(m[1]!, /\.(upsert|update|insert|delete)\(/, `${p} writes the menu`);
    }
  }
  assert.match(changes, /kind: "menu_change"/);
  const sql = src("db/migrations/049_restaurant_menus.sql");
  assert.match(sql, /enable row level security/);
  assert.match(sql, /menu_changes jsonb/);
});

test("the dashboard has a Menu tab and the chat's Update menu opens it", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /tab === "menu" && <MenuEditor/);
  assert.match(dash, /onOpenMenu=\{\(\) => setTab\("menu"\)\}/);
  assert.match(src("components/DispatchMessages.tsx"), /onOpenMenu\(\)/);
});

console.log(`\n${passed} passed`);
