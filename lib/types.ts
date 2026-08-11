export type OrderStatus = "new" | "opened" | "completed" | "printed";

export interface OrderItem {
  name: string;
  price: string | null;
  modifiers: string[];
}

export interface Order {
  id: string;
  restaurant_id: string;
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
  customer_total: number | null;
  payment_type: string | null;
  raw_html: string;
  status: OrderStatus;
  received_at: string;
  opened_at: string | null;
  completed_at: string | null;
  printed_at: string | null;
}
