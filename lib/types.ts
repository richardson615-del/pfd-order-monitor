/** 'cancelled' arrived with migration 004 and was never added here. */
export type OrderStatus = "new" | "opened" | "completed" | "printed" | "cancelled";

export interface OrderItem {
  name: string;
  price: string | null;
  modifiers: string[];
}

/**
 * Where the order came from. Staff need this operationally and for disputes -
 * "which platform was this on?" is the first question asked about a wrong
 * order, and until now the answer was stored and never shown.
 */
export type OrderSource = "email" | "zuppler" | "test";

export interface Order {
  id: string;
  restaurant_id: string;
  source: OrderSource | null;
  order_number: string;
  ticket_restaurant_name: string | null;
  order_type: "pickup" | "delivery" | null;
  due_time: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  items: OrderItem[];
  items_total: number | null;
  tax: number | null;
  service_fee: number | null;
  delivery_fee: number | null;
  /** Customer tip - the driver's money. */
  tip: number | null;
  /** Promotional discount. Reduces the total; not part of the component sum. */
  discount: number | null;
  customer_total: number | null;
  payment_type: string | null;
  /** Gate codes, allergies, delivery instructions. Printed in the NOTE box. */
  notes: string | null;
  /**
   * The original order EMAIL, when the order came from one. Null for every
   * webhook order - migration 002 dropped the NOT NULL for exactly that
   * reason - so nothing may render this as the primary view of an order.
   */
  raw_html: string | null;
  status: OrderStatus;
  received_at: string;
  /**
   * When someone at the restaurant explicitly accepted the order.
   *
   * Null means the alert is still sounding. Deliberately not the same thing as
   * opened_at: opening is a tap, and happens on a glance or a mis-tap;
   * accepting is somebody agreeing to make the food.
   */
  accepted_at: string | null;
  opened_at: string | null;
  completed_at: string | null;
  printed_at: string | null;
  /** Set when the order was cancelled upstream. The food must not be made. */
  cancelled_at: string | null;
}
