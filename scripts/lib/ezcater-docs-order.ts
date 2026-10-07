/** ezCater's own documented example order (https://api.ezcater.io/order-details), shared by the ezCater tests. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const money = (c: number) => ({ currency: "USD", subunits: c, subunitsV2: String(c) });
export const docsOrder = {
  deliveryId: "3593ce70-7227-4fd4-8a78-9591083d0674",
  uuid: "your-ezcater-order-id",
  caterer: { uuid: "ezcater-caterer-id", name: "My Caterer Name", storeNumber: "00001", live: true, address: { city: "Boston" } },
  catererCart: {
    feesAndDiscounts: [
      { cost: money(2999), name: "Delivery Fee" },
      { cost: money(-1199), name: "Preferred Caterer Program" },
      { cost: money(-1199), name: "Rewards Promo" },
    ],
    orderItems: [
      { customizations: [{ customizationTypeName: "Cheese Addon", name: "Parmigiano Reggiano", quantity: 10 }], labelFor: null, menuItemSizeName: '12" Pizza', name: "Margherita Pizza", noteToCaterer: '12" thin crust Margherita Pizza', quantity: 10, specialInstructions: "Please be careful not to burn crust", totalInSubunits: money(16750), uuid: "i1" },
      { customizations: [{ customizationTypeName: "Soda", name: "Select Soda", quantity: 10 }], labelFor: null, menuItemSizeName: "2ltr Soda", name: "Assorted Sodas", noteToCaterer: "2ltr brand name sodas from fridge", quantity: 10, specialInstructions: "Please bring cold soda if possible", totalInSubunits: money(2750), uuid: "i2" },
    ],
    tableware: { specialInstructions: null, tablewareChoices: [{ isIncluded: true, itemCount: 10, name: "Napkins" }, { isIncluded: true, itemCount: 10, name: "Plates" }, { isIncluded: false, itemCount: 10, name: "Forks" }] },
    totals: { catererTotalDue: 171.02 },
  },
  event: {
    address: { city: "Boston", deliveryInstructions: "Ask for Jane at front desk", name: "My Office", state: "MA", street: "2345 Business Boulevard", street2: null, zip: "23456" },
    catererHandoffFoodTime: "2025-03-27T16:15:00Z",
    contact: { name: "Jane Doe", phone: "5555555555" },
    customerProvidedName: "Team building event",
    headcount: 10,
    orderType: "DELIVERY",
    thirdPartyDeliveryPartner: null,
    timestamp: "2025-03-27T16:30:00Z",
  },
  lifecycle: { orderIsCurrently: "accepted" },
  orderCustomer: { fullName: "Jane Doe" },
  orderNumber: "O1O1O1",
  totals: { customerTotalDue: money(23864), salesTax: money(1365), subTotal: money(19500), tip: money(0) },
};
