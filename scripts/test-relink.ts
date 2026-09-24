/**
 * R1 (Nick, 2026-09-24): relink a restaurant here to another CRM account.
 *
 * The CRM has duplicate accounts for El Molcajete (29fafb74 -> fbd40571) and
 * J & L Liquors (f03dd879 -> 35fcaa49). Its merge refused to run because the
 * bridge restaurant was linked to the duplicate and nothing here could move
 * the link. The rules below are the brief's list, run against an in-memory
 * store that resolves references the way lib/restaurant-ref.ts does.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseRelinkBody, relinkRestaurant, type LinkedRestaurant, type RelinkStore } from "../lib/relink";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const EL_MOLCAJETE = "aaaaaaaa-1111-4111-8111-111111111111"; // the bridge's own id
const DUPLICATE = "29fafb74-b318-4de2-9fa9-2a8d379a8296";
const SURVIVOR = "fbd40571-51b1-4c6c-aa8c-8487cfa75d98";
const JL = "bbbbbbbb-2222-4222-8222-222222222222";
const JL_CRM = "35fcaa49-20cf-4854-a108-47fca96b4a9e";

interface World {
  restaurants: (LinkedRestaurant & { zuppler_restaurant_id: string; timezone: string })[];
  printers: { id: string; restaurant_id: string }[];
  tablets: { device_ref: string; restaurant_id: string }[];
  orders: { id: string; restaurant_id: string; received_at: string }[];
  audit: any[];
}

function world(): World {
  return {
    restaurants: [
      { id: EL_MOLCAJETE, name: "El Molcajete", crm_restaurant_id: DUPLICATE, zuppler_restaurant_id: "4101", timezone: "America/Chicago" },
      { id: JL, name: "J & L Liquors", crm_restaurant_id: JL_CRM, zuppler_restaurant_id: "4102", timezone: "America/Chicago" },
    ],
    printers: [{ id: "p1", restaurant_id: EL_MOLCAJETE }, { id: "p2", restaurant_id: JL }],
    tablets: [{ device_ref: "R8YL42BJPSB", restaurant_id: EL_MOLCAJETE }],
    orders: [
      { id: "o-before", restaurant_id: EL_MOLCAJETE, received_at: "2026-09-20T18:00:00Z" },
      { id: "o-jl", restaurant_id: JL, received_at: "2026-09-20T18:05:00Z" },
    ],
    audit: [],
  };
}

const pick = ({ id, name, crm_restaurant_id }: LinkedRestaurant): LinkedRestaurant => ({ id, name, crm_restaurant_id });

function storeOf(w: World): RelinkStore {
  return {
    async findByRef(ref) {
      const r = w.restaurants.find((x) => x.id === ref || x.crm_restaurant_id === ref);
      return r ? pick(r) : null;
    },
    async findOtherHolder(value, exceptId) {
      const r = w.restaurants.find((x) => x.id !== exceptId && (x.id === value || x.crm_restaurant_id === value));
      return r ? pick(r) : null;
    },
    async setCrmRestaurantId(id, value) {
      if (w.restaurants.some((x) => x.id !== id && x.crm_restaurant_id === value)) return "taken";
      w.restaurants.find((x) => x.id === id)!.crm_restaurant_id = value;
      return "ok";
    },
    async writeAudit(row) {
      w.audit.push({ ...row, created_at: new Date().toISOString() });
      return null;
    },
  };
}

/** GET /api/crm/accounting/orders?restaurant_id=: resolve the reference, then filter orders by our id. */
async function accountingOrders(w: World, ref: string) {
  const r = await storeOf(w).findByRef(ref);
  return r ? w.orders.filter((o) => o.restaurant_id === r.id) : null;
}

const relink = (w: World, ref: string, body: unknown) => relinkRestaurant(storeOf(w), ref, body);

(async () => {
  console.log("the body:");

  await test("crm_restaurant_id must be a uuid; anything else is 400", async () => {
    for (const bad of [undefined, "", "acct_123", "29fafb74", 42, null]) {
      const r = await relink(world(), EL_MOLCAJETE, { crm_restaurant_id: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      if (r.status === 400) assert.equal(r.code, "invalid_crm_restaurant_id");
    }
    assert.equal((await relink(world(), EL_MOLCAJETE, null)).status, 400, "no body");
  });

  await test("actor is trimmed and optional; the uuid is stored lower-case", () => {
    const p = parseRelinkBody({ crm_restaurant_id: ` ${SURVIVOR.toUpperCase()} `, actor: "  nick@pfdworks.com " });
    assert.ok(p.ok);
    if (p.ok) assert.deepEqual(p.input, { crm_restaurant_id: SURVIVOR, actor: "nick@pfdworks.com" });
    const q = parseRelinkBody({ crm_restaurant_id: SURVIVOR });
    assert.ok(q.ok && q.input.actor === null);
  });

  console.log("\nthe relink:");

  await test("an unknown restaurant is 404", async () => {
    const r = await relink(world(), "cccccccc-3333-4333-8333-333333333333", { crm_restaurant_id: SURVIVOR });
    assert.equal(r.status, 404);
  });

  await test("relink changes only crm_restaurant_id - printers, tablets, orders and settings stay put", async () => {
    const w = world();
    const before = JSON.parse(JSON.stringify(w));
    const r = await relink(w, DUPLICATE, { crm_restaurant_id: SURVIVOR, actor: "nick" });
    assert.equal(r.status, 200);
    if (r.status !== 200) return;
    assert.equal(r.changed, true);
    assert.equal(r.previous_crm_restaurant_id, DUPLICATE);
    assert.equal(r.restaurant.crm_restaurant_id, SURVIVOR);
    assert.equal(r.restaurant.id, EL_MOLCAJETE, "the restaurant's own id never changes");
    const expected = JSON.parse(JSON.stringify(before));
    expected.restaurants[0].crm_restaurant_id = SURVIVOR;
    expected.audit = w.audit;
    assert.deepEqual(w, expected);
  });

  await test("either id finds it: the bridge id works as well as the old CRM id", async () => {
    const r = await relink(world(), EL_MOLCAJETE, { crm_restaurant_id: SURVIVOR });
    assert.ok(r.status === 200 && r.changed);
  });

  await test("an audit row carries the actor, the old and the new account id", async () => {
    const w = world();
    await relink(w, DUPLICATE, { crm_restaurant_id: SURVIVOR, actor: "nick@pfdworks.com" });
    assert.equal(w.audit.length, 1);
    assert.deepEqual(
      { ...w.audit[0], created_at: undefined },
      { restaurant_id: EL_MOLCAJETE, old_crm_restaurant_id: DUPLICATE, new_crm_restaurant_id: SURVIVOR, actor: "nick@pfdworks.com", created_at: undefined }
    );
  });

  await test("a second call is changed:false and writes no second audit row", async () => {
    const w = world();
    await relink(w, DUPLICATE, { crm_restaurant_id: SURVIVOR });
    const again = await relink(w, SURVIVOR, { crm_restaurant_id: SURVIVOR });
    assert.equal(again.status, 200);
    if (again.status === 200) assert.equal(again.changed, false);
    assert.equal(w.audit.length, 1);
  });

  await test("an account another restaurant holds is 409 crm_account_taken, naming it - never a merge", async () => {
    const w = world();
    const r = await relink(w, EL_MOLCAJETE, { crm_restaurant_id: JL_CRM });
    assert.equal(r.status, 409);
    if (r.status === 409) {
      assert.equal(r.code, "crm_account_taken");
      assert.match(r.error, /J & L Liquors/);
      assert.match(r.error, new RegExp(JL));
    }
    assert.equal(w.restaurants[0].crm_restaurant_id, DUPLICATE, "nothing written");
    assert.equal(w.audit.length, 0);
  });

  await test("another restaurant's OWN id is taken too - references resolve against both columns", async () => {
    const r = await relink(world(), EL_MOLCAJETE, { crm_restaurant_id: JL });
    assert.equal(r.status, 409);
  });

  await test("losing a race to the unique index is 409 too, not a 500", async () => {
    const w = world();
    const store = storeOf(w);
    let first = true;
    const racing: RelinkStore = {
      ...store,
      async findOtherHolder(value, exceptId) {
        if (first) { first = false; return null; } // looked free...
        return store.findOtherHolder(value, exceptId);
      },
    };
    w.restaurants[1].crm_restaurant_id = SURVIVOR; // ...and J & L took it in between
    const r = await relinkRestaurant(racing, EL_MOLCAJETE, { crm_restaurant_id: SURVIVOR });
    assert.equal(r.status, 409);
    if (r.status === 409) assert.match(r.error, /J & L Liquors/);
  });

  console.log("\nafter the relink:");

  await test("the new account id resolves; the old one is 404", async () => {
    const w = world();
    await relink(w, DUPLICATE, { crm_restaurant_id: SURVIVOR });
    const s = storeOf(w);
    assert.equal((await s.findByRef(SURVIVOR))?.id, EL_MOLCAJETE);
    assert.equal(await s.findByRef(DUPLICATE), null);
    assert.equal(await accountingOrders(w, DUPLICATE), null, "accounting by the old id: restaurant not found");
  });

  await test("accounting orders by the new id include orders from before the relink", async () => {
    const w = world();
    await relink(w, DUPLICATE, { crm_restaurant_id: SURVIVOR });
    assert.deepEqual((await accountingOrders(w, SURVIVOR))?.map((o) => o.id), ["o-before"]);
  });

  console.log("\nthe real code keeps those promises:");

  await test("accounting resolves the reference to OUR id and filters orders by it - the link is the restaurant, not the order", () => {
    const a = src("app/api/crm/accounting/orders/route.ts");
    assert.match(a, /findRestaurantByRef(<[^>]*>)?\(ref/);
    assert.match(a, /\.eq\("restaurant_id", restaurantId\)/);
  });

  await test("no table but restaurants stores a CRM account id (so there is no per-order history to rewrite)", () => {
    const dir = new URL("../db/migrations/", import.meta.url);
    for (const f of readdirSync(dir)) {
      const sql = readFileSync(new URL(f, dir), "utf8");
      for (const m of sql.matchAll(/alter table\s+(\w+)\s+add column[^;]*crm_restaurant_id/gi)) {
        assert.equal(m[1], "restaurants", `${f} adds crm_restaurant_id to ${m[1]}`);
      }
      for (const m of sql.matchAll(/create table[^(]*?(\w+)\s*\(([^;]*?)\);/gi)) {
        if (/\bcrm_restaurant_id\b/.test(m[2])) assert.fail(`${f}: table ${m[1]} stores crm_restaurant_id`);
      }
    }
  });

  await test("the route is behind CRM_WRITE_KEY and updates exactly one column", () => {
    const r = src("app/api/crm/restaurants/[id]/relink/route.ts");
    assert.match(r, /authorizeCrmWrite\(req\)/);
    const updates = r.match(/\.update\(([^)]*)\)/g) ?? [];
    assert.deepEqual(updates, ["update({ crm_restaurant_id: value })"].map((u) => `.${u}`));
    assert.match(r, /23505/);
  });

  await test("the contract documents it", () => {
    assert.match(src("docs/crm-bridge-contract.md"), /\/api\/crm\/restaurants\/:id\/relink/);
  });

  console.log(`\n${passed} passed.`);
})();
