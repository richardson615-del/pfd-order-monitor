import * as cheerio from "cheerio";

export interface ParsedOrderItem {
  name: string;
  price: string | null;
  modifiers: string[];
}

export interface ParsedOrder {
  orderNumber: string;
  ticketRestaurantName: string | null;
  orderType: "pickup" | "delivery" | null;
  dueTime: string | null; // raw "MM/DD/YYYY HH:MM AM/PM" string; caller converts to a Date
  customerName: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  items: ParsedOrderItem[];
  itemsTotal: string | null;
  tax: string | null;
  serviceFee: string | null;
  customerTotal: string | null;
  paymentType: string | null;
}

const clean = (s: string | undefined | null) =>
  (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

/**
 * Parses the HTML order ticket format sent by PFD (see Order_1159.eml for a
 * reference sample). The ticket is a nested-table HTML email, so we rely on
 * a mix of structural selectors (for the item table) and label/text matching
 * (for totals + customer info), since the exact table layout can shift
 * slightly between order types without breaking the labels.
 */
export function parseOrderEmail(html: string): ParsedOrder {
  const $ = cheerio.load(html);

  // --- Header: restaurant name + order type, e.g. "Swezey's Pub PickUp" ---
  const headerText = clean($("font[size='5']").first().text());
  let ticketRestaurantName: string | null = null;
  let orderType: ParsedOrder["orderType"] = null;
  if (headerText) {
    const m = headerText.match(/^(.*?)(Pick\s*Up|Delivery)\s*$/i);
    if (m) {
      ticketRestaurantName = clean(m[1]);
      orderType = /deliv/i.test(m[2]) ? "delivery" : "pickup";
    } else {
      ticketRestaurantName = headerText;
    }
  }

  const bodyText = clean($.root().text());

  // --- Order number: "Order# 1159" ---
  const orderNumMatch = bodyText.match(/Order#\s*(\d+)/i);
  const orderNumber = orderNumMatch ? orderNumMatch[1] : "";

  // --- Due time: "ADVANCE ORDER DUE 07/03/2026 12:20 PM" ---
  const dueMatch = bodyText.match(
    /ADVANCE ORDER DUE\s*([\d/]+\s+\d{1,2}:\d{2}\s*[AP]M)/i
  );
  const dueTime = dueMatch ? dueMatch[1] : null;

  // --- Order type fallback from "FOR TAKEOUT" / "FOR DELIVERY" ---
  if (!orderType) {
    if (/FOR TAKEOUT/i.test(bodyText)) orderType = "pickup";
    else if (/FOR DELIVERY/i.test(bodyText)) orderType = "delivery";
  }

  // --- Items: walk the #tblOrder item box. Each item is its own inner
  // table with [spacer, name, price] cells; a modifier line directly below
  // it is an inner table with an <em> and no price. ---
  const items: ParsedOrderItem[] = [];
  $("#tblOrder td#borderBox")
    .find("> table")
    .each((_, innerTable) => {
      const row = $(innerTable).find("tr").first();
      const cells = row.find("td");
      if (cells.length < 2) return;

      const priceCellText = clean(cells.last().text());
      const isItemRow = /\$\d/.test(priceCellText);

      if (isItemRow) {
        const name = clean(cells.eq(cells.length - 2).text());
        if (name) items.push({ name, price: priceCellText, modifiers: [] });
      } else {
        const modText = clean($(innerTable).text());
        if (modText && items.length > 0) {
          items[items.length - 1].modifiers.push(modText);
        }
      }
    });

  // --- Totals: label cell + value cell in the same row, e.g. "Tax" | "$0.60" ---
  const getTotal = (label: string): string | null => {
    let found: string | null = null;
    $("td").each((_, td) => {
      if (clean($(td).text()) === label) {
        const val = clean($(td).parent().find("td").last().text());
        if (/\$\d/.test(val)) found = val;
      }
    });
    return found;
  };
  const itemsTotal = getTotal("Items");
  const tax = getTotal("Tax");
  const serviceFee = getTotal("Service Fees");
  const customerTotal = getTotal("C. Total");

  // --- Customer block: the rows right after the *second* <hr> contain, in
  // order, "Name (phone)", "Address", and "Payment type". ---
  let customerName: string | null = null;
  let customerPhone: string | null = null;
  let customerAddress: string | null = null;
  let paymentType: string | null = null;

  const hrs = $("hr");
  if (hrs.length > 0) {
    let sib = hrs.last().closest("tr").next();
    const lines: string[] = [];
    while (sib.length && lines.length < 6) {
      const t = clean(sib.text());
      if (t) lines.push(t);
      sib = sib.next();
    }

    if (lines[0]) {
      const phoneMatch = lines[0].match(/\(?\d{3}\)?\s*\d{3}-\d{4}/);
      if (phoneMatch && phoneMatch.index !== undefined) {
        customerPhone = clean(phoneMatch[0]);
        customerName = clean(lines[0].slice(0, phoneMatch.index));
      } else {
        customerName = lines[0];
      }
    }
    if (lines[1] && !/CARD|CASH|ONLINE/i.test(lines[1])) {
      customerAddress = lines[1];
    }
    const paymentLine = lines.find((l) => /CARD|CASH|ONLINE|PAY/i.test(l));
    if (paymentLine) paymentType = paymentLine;
  }

  return {
    orderNumber,
    ticketRestaurantName,
    orderType,
    dueTime,
    customerName,
    customerPhone,
    customerAddress,
    items,
    itemsTotal,
    tax,
    serviceFee,
    customerTotal,
    paymentType,
  };
}

/** Converts "07/03/2026 12:20 PM" -> a Date (assumes US Eastern-style MM/DD/YYYY). */
export function parseDueTimeToDate(dueTime: string | null): Date | null {
  if (!dueTime) return null;
  const m = dueTime.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i
  );
  if (!m) return null;
  let [, mo, d, y, h, min, ap] = m;
  let hour = parseInt(h, 10) % 12;
  if (ap.toUpperCase() === "PM") hour += 12;
  return new Date(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    hour,
    parseInt(min, 10)
  );
}

/** Converts a "$1,234.56" style string to a number, or null. */
export function moneyToNumber(s: string | null): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extracts the order number from a subject line like "Order 1159".
 * Returns null if the subject doesn't match the expected pattern.
 */
export function extractOrderNumberFromSubject(
  subject: string,
  pattern = "^Order\\s+(\\d+)"
): string | null {
  const re = new RegExp(pattern, "i");
  // The default pattern is anchored at the start, so a forwarded or replied
  // subject ("Fwd: Order 1195") would silently fail to be recognised as an
  // order. Strip any stack of Re:/Fwd:/Fw: prefixes first - a forwarded ticket
  // is still a ticket, and the order number is what matters.
  const stripped = String(subject ?? "").replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, "");
  const m = stripped.match(re) ?? String(subject ?? "").match(re);
  return m ? m[1] : null;
}
