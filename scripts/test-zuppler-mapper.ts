import { mapZupplerGraphqlOrder } from "@/lib/zuppler-mapper";

// Simulated LoadOrder GraphQL response matching Zuppler's documented shape
const resp = {
  data: {
    order: {
      uuid: "ed6add77-5b2e-40db-afb5-d64143e13abe",
      shortUuid: "5de2ecfc",
      state: "confirmed",
      pickupTime: null,
      deliveryTime: "2026-08-10T22:30:00Z",
      dueTime: "2026-08-10T22:30:00Z",
      createdAt: "2026-08-10T21:47:12Z",
      totals: {
        delivery: 399, discount: 0, includedTax: 0, service: 150,
        subtotal: 2700, tax: 257, tip: 500, total: 3506,
      },
      carts: [{
        restaurantId: 8841,
        comments: "Gate code 4482",
        instructions: "Leave at door",
        settings: { service: { id: "DELIVERY" }, tender: { id: "CREDIT" } },
        customer: { name: "Jane Doe", email: "jane@example.com", phone: "615-555-0100" },
        items: [
          { id: 1, name: "Cheeseburger", quantity: 2, itemTotal: 2300, comments: "No onions, add bacon" },
          { id: 2, name: "Fries", quantity: 1, itemTotal: 400, comments: null },
        ],
      }],
    },
  },
};

const m = mapZupplerGraphqlOrder(resp);
console.log("externalId:", m.externalId);
console.log("zupplerRestaurantId:", m.zupplerRestaurantId);
console.log("orderNumber:", m.canonical.orderNumber);
console.log("orderType:", m.canonical.orderType);
console.log("dueTime:", m.canonical.dueTime);
console.log("customer:", m.canonical.customerName, m.canonical.customerPhone);
console.log("items:", JSON.stringify(m.canonical.items));
console.log("totals:", m.canonical.itemsTotal, m.canonical.tax, m.canonical.serviceFee, m.canonical.customerTotal);
console.log("payment:", m.canonical.paymentType);
console.log("notes:", m.canonical.notes);

// Garbage in, no throw
const g = mapZupplerGraphqlOrder({ hello: "world" });
console.log("garbage:", g.externalId, g.zupplerRestaurantId, g.canonical.orderNumber);
