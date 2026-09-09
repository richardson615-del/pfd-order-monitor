/**
 * Renders a ticket to a PNG locally - no printer, no database, no network,
 * no CRM_WRITE_KEY.
 *
 *   npx tsx scripts/preview-ticket.ts
 *   npx tsx scripts/preview-ticket.ts --order ./order.json --restaurant "Roundies"
 *   npx tsx scripts/preview-ticket.ts --scale large --type delivery --out ./tmp
 *
 * Options (all optional):
 *   --order <file>       A Zuppler LoadOrder response to render: the raw
 *                        `{data:{order:...}}`, or a bare `{order:...}`, or the
 *                        order object itself. Without this, a built-in sample
 *                        with nested option groups is used.
 *   --restaurant <name>  Name printed at the top. Default "Sample Restaurant".
 *   --scale normal|large|both   Default both.
 *   --type pickup|delivery      Overrides what the order says.
 *   --out <dir>          Output directory. Default ./preview-out (gitignored).
 *
 * Why this exists (2026-09-09): Roundies order 61642f71 printed with every
 * modifier missing, and the restaurant is hours from anyone who could look at
 * the paper. "Go and check the printer" is a poor feedback loop for a layout
 * or mapping change, and a real order costs a kitchen real food.
 *
 * This is deliberately NOT a reimplementation of the ticket. It feeds the
 * order through the real Zuppler mapper and then the same renderTicketPreview
 * that backs /api/crm/restaurants/:id/ticket-preview - the header/body/footer
 * raster the printer itself receives - so it exercises the mapping and the
 * layout together and cannot quietly drift from what prints.
 *
 * It does NOT prove the live path: that Zuppler returns these fields for a
 * given restaurant's menu, that ingest stored them, or that the printer
 * renders the same bytes. Only a real order on real paper shows that
 * (docs/release-checklist.md, R4).
 */
import fs from "node:fs";
import path from "node:path";
import { mapZupplerGraphqlOrder } from "@/lib/zuppler-mapper";
import { renderTicketPreview } from "@/lib/ticket-preview";
import type { TicketOrder, TextScale } from "@/lib/ticket";

// money() reads this on every call; pin it so a stray shell value cannot
// silently render every figure 100x off.
delete process.env.ZUPPLER_AMOUNTS;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/**
 * A breakfast with nested option groups, one of them PAID - the shape that
 * was silently dropped before the items.modifiers selection was added to
 * LOAD_ORDER_QUERY. Matches the live schema: Item.modifiers is a list of
 * Modifier, Modifier.options a list of ModifierOption, prices Int cents.
 */
const SAMPLE_ZUPPLER_RESPONSE = {
  data: {
    order: {
      uuid: "00000000-0000-4000-8000-000000000000",
      shortUuid: "5a3f9c21",
      state: "confirmed",
      createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      pickupTime: new Date(Date.now() + 22 * 60_000).toISOString(),
      totals: {
        subtotal: 4800, tax: 407, service: 0, delivery: 0,
        tip: 400, discount: 0, includedTax: 0, hidden: 0, total: 5607,
      },
      carts: [{
        restaurantId: 29905,
        settings: { service: { id: "PICKUP" }, tender: { id: "CREDIT" } },
        customer: { name: "Sam Whitfield", phone: "615-555-0142" },
        items: [
          {
            id: 1, name: "Country Breakfast", quantity: 1, itemTotal: 1400, comments: null,
            modifiers: [
              { name: "Choice of Eggs", priority: 1, options: [{ name: "Over Easy", price: 0, quantity: 1, total: 0 }] },
              { name: "Choice of Bread", priority: 2, options: [{ name: "Biscuit", price: 0, quantity: 1, total: 0 }] },
              { name: "Choice of Side", priority: 3, options: [{ name: "Hash Brown Casserole", price: 0, quantity: 1, total: 0 }] },
              { name: "Extras", priority: 4, options: [{ name: "Add Gravy", price: 100, quantity: 1, total: 100 }] },
            ],
          },
          {
            id: 2, name: "Biscuits & Gravy", quantity: 2, itemTotal: 2200, comments: "extra crispy",
            modifiers: [{ name: "Gravy", priority: 1, options: [{ name: "Sausage Gravy", price: 0, quantity: 1, total: 0 }] }],
          },
          { id: 3, name: "Coffee", quantity: 2, itemTotal: 1200, comments: null, modifiers: [] },
        ],
      }],
    },
  },
};

const orderFile = arg("order");
let source: unknown = SAMPLE_ZUPPLER_RESPONSE;
if (orderFile) {
  if (!fs.existsSync(orderFile)) {
    console.error(`--order file not found: ${orderFile}`);
    process.exit(1);
  }
  source = JSON.parse(fs.readFileSync(orderFile, "utf8"));
}
// mapZupplerGraphqlOrder already unwraps data.order / order / the bare object.
const c = mapZupplerGraphqlOrder(source).canonical;

const typeArg = arg("type");
const orderType = typeArg === "delivery" || typeArg === "pickup" ? typeArg : c.orderType;

const order = {
  order_number: c.orderNumber,
  ticket_restaurant_name: arg("restaurant") ?? "Sample Restaurant",
  order_type: orderType,
  due_time: c.dueTime,
  received_at: c.receivedAt,
  customer_name: c.customerName,
  customer_phone: c.customerPhone,
  customer_address:
    orderType === "delivery" && !c.customerAddress
      ? "4445 Mount Zion Road, Springfield, TN 37172 | Ring the bell"
      : c.customerAddress,
  items: c.items,
  items_total: c.itemsTotal,
  tax: c.tax,
  service_fee: c.serviceFee,
  delivery_fee: c.deliveryFee,
  tip: c.tip,
  // The field is customer_total, NOT total. Getting it wrong does not throw -
  // it silently omits the TOTAL line, which is the one figure that has to
  // match the customer's receipt to the cent. Same trap as
  // ticket_restaurant_name, which falls back to printing "PFD ORDER".
  customer_total: c.customerTotal,
  payment_type: c.paymentType,
  notes: c.notes,
} as TicketOrder;

const scaleArg = arg("scale") ?? "both";
const scales: TextScale[] =
  scaleArg === "normal" ? ["normal"] : scaleArg === "large" ? ["large"] : ["normal", "large"];

const outDir = arg("out") ?? "./preview-out";
fs.mkdirSync(outDir, { recursive: true });

const slug = (order.ticket_restaurant_name || "ticket")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "") || "ticket";

(async () => {
  for (const scale of scales) {
    const png = await renderTicketPreview({ order, scale });
    const file = path.join(outDir, `ticket-${slug}-${scale}.png`);
    fs.writeFileSync(file, png);
    console.log(`wrote ${file}  (${(png.length / 1024).toFixed(1)} KB)`);
  }

  // Printed because a blank modifier list is the failure this tool was built
  // to catch, and it is easy to miss in a picture of a receipt.
  console.log("\nMapped modifier lines:");
  for (const it of c.items ?? []) {
    const mods = it.modifiers ?? [];
    console.log(`  ${it.name}: ${mods.length ? JSON.stringify(mods) : "(none)"}`);
  }
})().catch((err) => {
  console.error("preview failed:", err);
  process.exit(1);
});
