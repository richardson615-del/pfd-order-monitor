import { createCanvas, Canvas } from "@napi-rs/canvas";
import { buildTicket, TicketOrder, TextScale } from "./ticket";
import {
  renderHeader, renderFooter, PAPER_WIDTH, TicketDesign, FooterMode,
  DEFAULT_FOOTER_TEXT_MARK,
} from "./ticket-raster";

/**
 * Renders a whole ticket to an image.
 *
 * This exists so the CRM can show what will actually print BEFORE anything is
 * saved. It is the same header and footer the printer receives; only the body
 * differs, and only in how it is drawn - the printer renders those lines as
 * native text, so they are drawn here to the printer's own metrics (48
 * columns across 576 dots, double-height meaning taller and never wider).
 * Getting that wrong would make the preview a lie in exactly the place people
 * would trust it.
 */

export interface PreviewInput {
  order: TicketOrder;
  design?: TicketDesign;
  scale?: TextScale;
  footerMode?: FooterMode;
  footerText?: string | null;
  footerUrl?: string | null;
  logo?: Buffer | null;
  footerImage?: Buffer | null;
}

const COLS = 48;
const LINE_H = 26;

function renderBody(lines: any[]): Canvas {
  const probe = createCanvas(10, 10).getContext("2d");
  probe.font = "20px monospace";
  const size =
    Math.floor(20 * ((PAPER_WIDTH / COLS) / probe.measureText("M").width) * 100) / 100;

  const isDoubleWide = (l: any) => l.size === "double" && (l.text ?? "").length <= COLS / 2;
  const heightOf = (l: any) =>
    isDoubleWide(l) ? LINE_H * 2 + 6 : l.size ? LINE_H + 16 : LINE_H;

  const h = lines.reduce((a, l) => a + heightOf(l), 0) + 12;
  const c = createCanvas(PAPER_WIDTH, h);
  const x = c.getContext("2d");
  x.fillStyle = "#fff";
  x.fillRect(0, 0, PAPER_WIDTH, h);
  x.fillStyle = "#000";
  x.textBaseline = "top";

  let y = 6;
  for (const l of lines) {
    x.font = `${l.bold ? "bold " : ""}${size}px monospace`;
    if (isDoubleWide(l)) {
      x.save(); x.translate(0, y); x.scale(2, 2); x.fillText(l.text, 0, 0); x.restore();
    } else if (l.size) {
      x.save(); x.translate(0, y); x.scale(1, 1.7); x.fillText(l.text, 0, 0); x.restore();
    } else {
      x.fillText(l.text, 0, y);
    }
    y += heightOf(l);
  }
  return c;
}

/** The body between the raster header and footer, which own the rest. */
function sliceBody(lines: any[]): any[] {
  const start = lines.findIndex((l: any) => /^ORDER #/.test(l.text ?? ""));
  if (start === -1) return lines;
  const end = lines.findIndex((l: any, i: number) => i > start && /^=+$/.test(l.text ?? ""));
  return lines.slice(start, end === -1 ? lines.length : end);
}

export async function renderTicketPreview(input: PreviewInput): Promise<Buffer> {
  const lines = buildTicket(
    input.order, COLS,
    { text: input.footerText, url: input.footerUrl },
    { scale: input.scale ?? "normal" }
  );
  const dueLine = lines.find((l) => /^DUE /.test(l.text ?? ""))?.text ?? null;

  const header = await renderHeader({
    restaurantName: input.order.ticket_restaurant_name || "PFD ORDER",
    orderType: input.order.order_type || "order",
    dueText: dueLine,
    design: input.design,
    logo: input.logo,
  });
  const footer = await renderFooter({
    text: (input.footerText || "").trim() || DEFAULT_FOOTER_TEXT_MARK,
    url: input.footerUrl,
    design: input.design,
    mode: input.footerMode,
    image: input.footerImage,
  });
  const body = renderBody(sliceBody(lines));

  const GAP = 26;
  const total = header.height + body.height + GAP + footer.height;
  const c = createCanvas(PAPER_WIDTH, total);
  const x = c.getContext("2d");
  x.fillStyle = "#fff";
  x.fillRect(0, 0, PAPER_WIDTH, total);
  let y = 0;
  x.drawImage(header, 0, y); y += header.height;
  x.drawImage(body, 0, y);   y += body.height + GAP;
  x.drawImage(footer, 0, y);
  return c.toBuffer("image/png");
}

/** A believable order, so a preview shows real wrapping and real money. */
export const SAMPLE_ORDER: TicketOrder = {
  order_number: "a1b2c3d4",
  ticket_restaurant_name: "Sample Restaurant",
  order_type: "pickup",
  due_time: new Date(Date.now() + 25 * 60_000).toISOString(),
  received_at: new Date().toISOString(),
  customer_name: "Sam Whitfield",
  customer_phone: "615-555-0142",
  items: [
    { name: "Ahi Tuna", price: "$15.00", modifiers: ["NO ONIONS", "SEARED RARE"] },
    { name: "2x Chicken Fettuccine Alfredo", price: "$24.00", modifiers: ["EXTRA SAUCE"] },
  ],
  items_total: 39, tax: 2.34, service_fee: 5.27, customer_total: 46.61,
  payment_type: "CREDIT",
};
