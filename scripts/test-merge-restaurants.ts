/**
 * The merge route's rules (lib/merge-restaurants.ts). The database half,
 * merge_restaurants (migration 064), is tested by
 * scripts/test-merge-restaurants.sql against a local Postgres with the schema
 * and every migration applied.
 */
import assert from "node:assert/strict";
import { mergeErrorFor, parseMergeBody } from "../lib/merge-restaurants";

assert.deepEqual(parseMergeBody({ into: "58410dfa-6ebb-47b5-a449-7ba3bbb18b02" }), {
  ok: true,
  input: { into: "58410dfa-6ebb-47b5-a449-7ba3bbb18b02", take_crm: false, actor: null },
});
assert.deepEqual(parseMergeBody({ into: " abc ", take_crm: true, actor: " Matt " }), { ok: true, input: { into: "abc", take_crm: true, actor: "Matt" } });
assert.equal((parseMergeBody(null) as { code: string }).code, "invalid_body");
assert.equal((parseMergeBody([]) as { code: string }).code, "invalid_body");
assert.equal((parseMergeBody({}) as { code: string }).code, "invalid_into");
assert.equal((parseMergeBody({ into: "a b" }) as { code: string }).code, "invalid_into");
assert.equal((parseMergeBody({ into: "x", take_crm: "yes" }) as { code: string }).code, "invalid_take_crm");

assert.deepEqual(mergeErrorFor("statement_conflict").status, 409);
assert.equal(mergeErrorFor("restaurant_not_found").status, 404);
assert.equal(mergeErrorFor("merge_same_restaurant").status, 400);
assert.equal(mergeErrorFor("into_inactive").status, 409);
const other = mergeErrorFor("deadlock detected");
assert.deepEqual(other, { status: 500, code: "merge_failed", error: "deadlock detected" });
assert.equal(mergeErrorFor(null).status, 500);

console.log("test-merge-restaurants: ok");
