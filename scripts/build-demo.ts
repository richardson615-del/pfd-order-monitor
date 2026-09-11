/**
 * Builds public/demo.html - the public, no-login demo of the order tablet.
 *
 * A GENERATOR rather than a hand-written page, for one reason: the demo is
 * only worth anything while it shows what the app actually does. A snapshot
 * committed once would go stale the first time the ticket or the stylesheet
 * changed, and nothing would say so - it would just quietly start showing
 * customers something the kitchen never sees.
 *
 * So the ticket comes from buildTicket(), the same function the Epson
 * receives, styled with ticketLineClass(), the same rules the in-app screen
 * uses; and the CSS is app/globals.css inlined verbatim. Re-run after
 * changing either:
 *
 *     npm run build:demo
 *
 * The orders below are invented. Nothing here reaches a database, and the
 * page is a single self-contained file - no server, no login, no network.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildTicket, ticketLineClass, type TicketOrder } from "@/lib/ticket";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Renders one order's ticket exactly as the in-app screen does. */
function ticketHtml(order: TicketOrder): string {
  const lines = buildTicket(order, 48, {}, { omitFooter: true });
  const body = lines
    .map((l) =>
      l.qr
        ? '<div class="tl tl-c tl-note">[QR code prints here]</div>'
        : `<div class="${ticketLineClass(l)}">${esc(l.text === "" ? " " : l.text)}</div>`
    )
    .join("");
  return `<div class="receipt"><div class="receipt-paper">${body}</div></div>`;
}

const at = (m: number) => new Date(Date.now() + m * 60000).toISOString();

const ORDERS: (TicketOrder & { customer_total: number })[] = [
  {
    order_number: "2bed4416", ticket_restaurant_name: "Swezey's Pub",
    order_type: "delivery", due_time: at(38), received_at: at(-2),
    customer_name: "Eileen Gutierrez", customer_phone: "(931) 302-3610",
    customer_address: "254 Village Square, Pleasant View, 37146 | Gate code 4471 | Leave at side door",
    items: [
      { name: "2x Loaded Fries", price: "$13.00", modifiers: ["Lemon pepper x 1", "No sour cream"] },
      { name: "Smash Burger", price: "$11.50", modifiers: ["NO ONIONS", "Add bacon", "Medium well"] },
      { name: "Chocolate Milkshake", price: "$7.25", modifiers: [] },
    ],
    items_total: 31.75, tax: 2.93, service_fee: 1.59, delivery_fee: 4.99, tip: 6.0,
    customer_total: 44.76, payment_type: "CARD - Channel: zuppler",
    notes: "Allergy: shellfish. Ring the bell twice.",
  },
  {
    order_number: "9fa21c07", ticket_restaurant_name: "Swezey's Pub",
    order_type: "pickup", due_time: at(22), received_at: at(-1),
    customer_name: "Marquita Clark", customer_phone: "(615) 555-0142",
    items: [
      { name: "3x Wings", price: "$24.00", modifiers: ["Hot", "Ranch on the side"] },
      { name: "Loaded FF", price: "$6.50", modifiers: ["Lemon pep. X 1"] },
    ],
    items_total: 30.5, tax: 2.81, service_fee: 1.52, customer_total: 34.83,
    payment_type: "CARD - Channel: zuppler",
  },
  {
    order_number: "77c1e934", ticket_restaurant_name: "Swezey's Pub",
    order_type: "delivery", due_time: at(55), received_at: at(-1),
    customer_name: "Greg Bishop", customer_phone: "(931) 555-0177",
    customer_address: "88 Oak Ridge Rd, Ashland City, 37015 | Apartment 3B, buzzer broken",
    items: [
      { name: "Family Platter", price: "$48.00", modifiers: ["No pork", "Extra slaw"] },
      { name: "2x Sweet Tea", price: "$5.00", modifiers: [] },
    ],
    items_total: 53.0, tax: 4.89, service_fee: 2.65, delivery_fee: 4.99, tip: 9.0,
    customer_total: 74.53, payment_type: "CARD - Channel: zuppler",
    notes: "Please knock, doorbell does not work.",
  },
];

const demoOrders = ORDERS.map((o, i) => ({
  id: `demo${i}`,
  number: o.order_number,
  who: o.customer_name,
  type: o.order_type === "delivery" ? "Delivery" : "Pickup",
  total: `$${o.customer_total.toFixed(2)}`,
  ticket: ticketHtml(o),
}));

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PFD Order Tablet - Demo</title>
<meta name="description" content="A working demo of the PFD kitchen order tablet. Invented orders, no login.">
<meta name="robots" content="noindex">
<style>
${css}
</style>
<style>
  /* Demo harness. Prefixed dx- throughout so nothing can collide with the app
     stylesheet above, which is inlined unmodified. */
  body { background: #090c12; }
  .dx-wrap { max-width: 1140px; margin: 0 auto; padding: 32px 20px 72px; }
  .dx-head { border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 26px; }
  .dx-head h1 { font-size: clamp(24px, 5vw, 34px); margin: 0 0 8px; letter-spacing: -0.02em; color: var(--text); }
  .dx-head p { margin: 0 0 10px; color: var(--text-dim); font-size: 15px; line-height: 1.55; max-width: 64ch; }
  .dx-note {
    margin-top: 14px; padding: 10px 13px; border-radius: 8px;
    background: rgba(79,140,255,0.1); border: 1px solid rgba(79,140,255,0.35);
    color: var(--text-dim); font-size: 13.5px; line-height: 1.5;
  }
  .dx-note b { color: var(--text); }
  .dx-stage { display: grid; gap: 26px; grid-template-columns: minmax(0, 420px) minmax(0, 1fr); align-items: start; }
  @media (max-width: 860px) { .dx-stage { grid-template-columns: 1fr; } }
  .dx-device { border: 11px solid #222839; border-radius: 24px; background: var(--bg); overflow: hidden; box-shadow: 0 22px 60px rgba(0,0,0,0.6); }
  .dx-screen { height: 640px; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .dx-screen .action-bar { position: sticky; bottom: 0; }
  /* The app sizes the ticket in vw, which is correct on a real tablet where
     the viewport IS the device. Here the device is a small frame inside a
     larger page, so vw over-sizes the 48-column ticket. Harness-only; the
     app's own stylesheet is untouched and fills a real screen as designed. */
  .dx-screen .receipt-paper { font-size: 11px; }
  .dx-panel { border: 1px solid var(--border); border-radius: 12px; background: var(--panel); padding: 16px; }
  .dx-panel + .dx-panel { margin-top: 14px; }
  .dx-panel h2 { font-size: 14px; margin: 0 0 4px; color: var(--text); }
  .dx-panel p { margin: 0 0 12px; color: var(--text-dim); font-size: 13px; line-height: 1.5; }
  .dx-panel p:last-child { margin-bottom: 0; }
  .dx-btn {
    display: block; width: 100%; text-align: left; padding: 11px 13px; margin-bottom: 8px;
    border-radius: 9px; border: 1px solid var(--border); background: var(--panel-2);
    color: var(--text); font-size: 14px; font-weight: 600; font-family: inherit;
  }
  .dx-btn:last-child { margin-bottom: 0; }
  .dx-btn:hover { border-color: var(--accent); }
  .dx-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dx-btn small { display: block; font-weight: 400; color: var(--text-dim); font-size: 12px; margin-top: 2px; }
  .dx-btn[aria-pressed="true"] { border-color: var(--new); background: rgba(255,90,95,0.12); }
  .dx-steps { margin: 0; padding-left: 1.1em; color: var(--text-dim); font-size: 13px; line-height: 1.6; }
  .dx-steps li { margin-bottom: 7px; }
  .dx-steps b { color: var(--text); }
  .dx-foot { margin-top: 30px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--text-dim); font-size: 12.5px; line-height: 1.6; }
</style>
</head>
<body>
<div class="dx-wrap">
  <header class="dx-head">
    <h1>PFD Order Tablet</h1>
    <p>
      The kitchen tablet, running. The ticket is produced by the same renderer that drives the
      receipt printer, and the styling is the app's own &mdash; but the orders are invented and there
      is no server behind this page, so nothing here touches a real restaurant.
    </p>
    <p class="dx-note">
      <b>Turn your sound on.</b> The alert is the point. The red bar you see first is real behaviour
      &mdash; a browser will not make a sound until someone has touched the screen, which is why a
      tablet that starts itself up announces that it is silent rather than just being silent.
    </p>
  </header>

  <div class="dx-stage">
    <div class="dx-device"><div class="dx-screen" id="screen"></div></div>
    <div>
      <div class="dx-panel">
        <h2>Try it</h2>
        <ol class="dx-steps">
          <li><b>Touch the screen</b> &mdash; the sound warning clears.</li>
          <li><b>Send an order</b> &mdash; it arrives and starts chiming.</li>
          <li><b>Tap the order</b> &mdash; it opens as the ticket. The chime keeps going.</li>
          <li><b>Press Accept</b> &mdash; only this stops it.</li>
        </ol>
      </div>
      <div class="dx-panel">
        <h2>Controls</h2>
        <button class="dx-btn" id="send">Send an order<small>As if one had just come in</small></button>
        <button class="dx-btn" id="wifi" aria-pressed="false">Simulate a wifi drop<small>A screen that cannot reach the server says so</small></button>
        <button class="dx-btn" id="reset">Reset<small>Back to an empty, freshly started tablet</small></button>
      </div>
      <div class="dx-panel">
        <h2>What is real here</h2>
        <p>The ticket layout, the styling, the sound rule, the chime, the wording of every banner, and the fact that only Accept silences it.</p>
        <p>Not real: the orders, and the server. In the live app orders arrive the moment they are placed, and the screen re-checks every minute as a backstop.</p>
      </div>
    </div>
  </div>

  <footer class="dx-foot">
    Demonstration only &mdash; this is not a live order screen. The real app installs to an Android
    tablet from the browser, with no app store.
  </footer>
</div>

<script>
const DEMO_ORDERS = ${JSON.stringify(demoOrders)};

let ctx = null;
function audioContext() {
  if (ctx) return ctx;
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    return ctx;
  } catch (e) { return null; }
}
async function armAudio() {
  const c = audioContext();
  if (!c) return false;
  try { if (c.state !== "running") await c.resume(); } catch (e) {}
  return c.state === "running";
}
function beep() {
  const c = audioContext();
  if (!c || c.state !== "running") return;
  const now = c.currentTime;
  [880, 1108].forEach(function (freq, i) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = now + i * 0.18;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.18);
  });
}

const state = { orders: [], view: "list", openId: null, armed: false, offline: false, next: 0 };
let chime = null;
const waiting = () => state.orders.filter((o) => !o.accepted && o.status !== "completed");

function syncChime() {
  if (waiting().length && state.armed) {
    if (!chime) { beep(); chime = setInterval(beep, 8000); }
  } else if (chime) { clearInterval(chime); chime = null; }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function banner() {
  if (!state.armed) return '<div class="kiosk-banner kiosk-critical">Sound is off &mdash; touch the screen to turn on order alerts</div>';
  if (state.offline) return '<div class="kiosk-banner kiosk-critical">Not receiving orders &mdash; reconnecting. Check this tablet\\'s wifi.</div>';
  return "";
}

function listView() {
  const w = waiting().length;
  const bar = w ? '<div class="waiting-bar">' + (w === 1 ? "1 order waiting &mdash; open it and press Accept" : w + " orders waiting &mdash; open each one and press Accept") + "</div>" : "";
  const cards = state.orders.length
    ? state.orders.map(function (o) {
        const st = o.accepted ? (o.status === "completed" ? "completed" : "opened") : "new";
        const label = o.accepted ? (o.status === "completed" ? "completed" : "accepted") : "new";
        return '<a class="order-card status-' + st + '" data-open="' + o.id + '">' +
          '<div class="order-card-top"><span class="order-number">Order #' + esc(o.number) +
          '<span class="badge status-' + st + '">' + label + '</span></span>' +
          '<span class="order-total">' + esc(o.total) + "</span></div>" +
          '<div class="order-meta">' + esc(o.who) + " &middot; " + esc(o.type) + " &middot; just now</div>" +
          '<span class="order-source">Zuppler</span></a>';
      }).join("")
    : '<div class="empty-state">No orders here yet.</div>';
  return banner() + bar +
    '<div class="topbar"><h1>PFD Orders</h1><span class="success-text">Notifications on</span></div>' +
    '<div class="tabs"><button class="tab active">All</button><button class="tab">New (' + w + ')</button><button class="tab">Completed</button></div>' +
    '<div class="order-list">' + cards + "</div>";
}

function ticketView() {
  const o = state.orders.find((x) => x.id === state.openId);
  if (!o) return listView();
  return banner() +
    '<div class="topbar"><span class="btn small" data-back="1">&larr; Back</span><h1>Order #' + esc(o.number) + "</h1>" +
    '<span class="badge status-' + (o.accepted ? "opened" : "new") + '">' + (o.accepted ? "accepted" : "new") + "</span></div>" +
    o.ticket +
    '<div class="action-bar"><span class="btn">Call customer</span><span class="btn">Print</span>' +
    (o.accepted
      ? '<span class="accepted-mark">Accepted ' + esc(o.acceptedAt) + "</span>"
      : '<button class="btn accept" data-accept="' + o.id + '">Accept order</button>') +
    '<button class="btn primary" data-complete="' + o.id + '">Mark complete</button></div>';
}

function render() {
  document.getElementById("screen").innerHTML = state.view === "ticket" ? ticketView() : listView();
  syncChime();
  document.getElementById("wifi").setAttribute("aria-pressed", String(state.offline));
}

async function onGesture() {
  const ok = await armAudio();
  const changed = ok !== state.armed;
  state.armed = ok;
  if (changed) render();
}
window.addEventListener("pointerdown", onGesture);
window.addEventListener("keydown", onGesture);

const now = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

document.getElementById("screen").addEventListener("click", function (e) {
  const open = e.target.closest("[data-open]");
  const back = e.target.closest("[data-back]");
  const accept = e.target.closest("[data-accept]");
  const complete = e.target.closest("[data-complete]");
  if (open) { state.openId = open.dataset.open; state.view = "ticket"; render(); }
  else if (back) { state.view = "list"; render(); }
  else if (accept) {
    const o = state.orders.find((x) => x.id === accept.dataset.accept);
    if (o) { o.accepted = true; o.acceptedAt = now(); }
    render();
  } else if (complete) {
    const o = state.orders.find((x) => x.id === complete.dataset.complete);
    if (o) { o.status = "completed"; o.accepted = true; o.acceptedAt = o.acceptedAt || now(); }
    state.view = "list"; render();
  }
});

document.getElementById("send").addEventListener("click", function () {
  const t = DEMO_ORDERS[state.next % DEMO_ORDERS.length];
  state.next += 1;
  state.orders.unshift(Object.assign({}, t, { id: t.id + "-" + state.next, accepted: false, status: "new" }));
  state.view = "list";
  render();
});
document.getElementById("wifi").addEventListener("click", function () { state.offline = !state.offline; render(); });
document.getElementById("reset").addEventListener("click", function () {
  state.orders = []; state.view = "list"; state.openId = null; state.offline = false; state.next = 0; render();
});

render();
</script>
</body>
</html>
`;

const out = new URL("../public/demo.html", import.meta.url);
writeFileSync(out, page);
console.log(`wrote public/demo.html (${(page.length / 1024).toFixed(1)} KB, ${demoOrders.length} orders)`);
