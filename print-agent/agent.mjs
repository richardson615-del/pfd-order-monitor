#!/usr/bin/env node
/**
 * PFD print agent.
 *
 * Runs on any always-on machine on the SAME NETWORK as the receipt printer
 * (Raspberry Pi, mini PC, back-office computer). Vercel cannot reach a printer
 * behind the restaurant's NAT, so the agent pulls work instead of being pushed
 * to:
 *
 *   GET  /api/print/jobs   -> claims queued jobs + returns the order data
 *   render ESC/POS         -> write to printer
 *   POST /api/print/jobs   -> report "printed" or "failed"
 *
 * Zero dependencies - Node 18+ only (global fetch, node:net).
 *
 *   node agent.mjs            run the poll loop
 *   node agent.mjs --sample   render a sample ticket to stdout (no printer)
 *   node agent.mjs --once     one poll cycle, then exit (for cron/testing)
 *
 * Transport is deliberately isolated in sendToPrinter(). A Bluetooth printer
 * later means replacing that one function; the renderer is untouched.
 */
import net from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

// --- config -----------------------------------------------------------------

const cfg = {
  apiBase: (process.env.PFD_API_BASE || "https://pfd-order-monitor.vercel.app").replace(/\/$/, ""),
  deviceKey: process.env.PFD_DEVICE_KEY || "",
  // "tcp"  - network printer on port 9100 (preferred: no host PC in the loop)
  // "usb"  - printer attached to THIS machine, via the OS print queue
  transport: (process.env.PRINTER_TRANSPORT || (process.env.SYSTEM_PRINTER ? "usb" : "tcp")).toLowerCase(),
  systemPrinter: process.env.SYSTEM_PRINTER || "",
  printerHost: process.env.PRINTER_HOST || "",
  printerPort: Number(process.env.PRINTER_PORT || 9100),
  eposPort: Number(process.env.EPOS_PORT || 80),
  eposDevId: process.env.EPOS_DEVICE_ID || "local_printer",
  pollMs: Number(process.env.POLL_INTERVAL_MS || 5000),
  // 80mm at Font A = 48 columns. 58mm printers are 32 - set PAPER_COLS=32.
  cols: Number(process.env.PAPER_COLS || 48),
  printerName: process.env.PRINTER_NAME || "NS8360",
  agentVersion: "1.0.0",
};

const args = new Set(process.argv.slice(2));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const errlog = (...a) => console.error(new Date().toISOString(), ...a);

// --- ticket model -----------------------------------------------------------
// Lines are built as plain data first, so the same ticket can be rendered to
// ESC/POS bytes or to stdout for previewing without hardware.

const L = (text = "", opts = {}) => ({ text, ...opts });

function money(v) {
  // Postgres numeric can arrive as number or string depending on the driver.
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function fmt(v) {
  const n = money(v);
  return n === null ? null : `$${n.toFixed(2)}`;
}

/** "Label................$1.23" - value flushed right within `cols`. */
function pad(left, right, cols) {
  const l = String(left ?? "");
  const r = String(right ?? "");
  const gap = cols - l.length - r.length;
  return gap >= 1 ? l + " ".repeat(gap) + r : `${l} ${r}`;
}

/** Hard-wrap, preserving an indent on continuation lines. */
function wrap(text, cols, indent = 0) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const pre = " ".repeat(indent);
  const out = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    const limit = out.length === 0 ? cols : cols - indent;
    if (candidate.length > limit && line) {
      out.push(out.length === 0 ? line : pre + line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) out.push(out.length === 0 ? line : pre + line);
  return out.length ? out : [""];
}

function localTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function buildTicket(order, cols) {
  const rule = "-".repeat(cols);
  const lines = [];

  lines.push(L(order.ticket_restaurant_name || "PFD ORDER", { align: "center", size: "double", bold: true }));
  const kind = (order.order_type || "order").toUpperCase();
  const via = order.source === "zuppler" ? "ZUPPLER" : "EMAIL";
  lines.push(L(`${kind}  -  via ${via}`, { align: "center" }));
  lines.push(L(rule));

  lines.push(L(`ORDER #${order.order_number ?? "?"}`, { align: "center", size: "double", bold: true }));

  const due = localTime(order.due_time);
  if (due) lines.push(L(`DUE: ${due}`, { align: "center", bold: true }));
  const recv = localTime(order.received_at);
  if (recv) lines.push(L(`received ${recv}`, { align: "center" }));
  lines.push(L(rule));

  // --- customer ---
  if (order.customer_name) lines.push(L(order.customer_name, { bold: true }));
  if (order.customer_phone) lines.push(L(order.customer_phone));
  if (order.customer_address) {
    for (const l of wrap(order.customer_address, cols)) lines.push(L(l));
  }
  if (order.customer_name || order.customer_phone || order.customer_address) {
    lines.push(L(rule));
  }

  // --- items ---
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) {
    lines.push(L("(no itemization available)"));
  }
  for (const it of items) {
    const price = typeof it?.price === "string" ? it.price : fmt(it?.price);
    const name = it?.name ?? "Item";
    const nameCols = price ? cols - price.length - 1 : cols;
    const wrapped = wrap(name, nameCols);
    lines.push(L(pad(wrapped[0], price ?? "", cols), { bold: true }));
    for (const extra of wrapped.slice(1)) lines.push(L(extra, { bold: true }));
    for (const mod of it?.modifiers ?? []) {
      // Wrap to the indented width, then indent - wrapping to full width and
      // then indenting overflows the paper by exactly the indent.
      for (const l of wrap(`* ${mod}`, cols - 2)) lines.push(L(`  ${l}`));
    }
  }
  lines.push(L(rule));

  // --- money ---
  const rows = [
    ["Subtotal", order.items_total],
    ["Tax", order.tax],
    ["Service", order.service_fee],
    ["Delivery", order.delivery_fee],
  ];
  for (const [label, v] of rows) {
    const f = fmt(v);
    if (f !== null) lines.push(L(pad(label, f, cols)));
  }
  // The tip is the DRIVER's money - call it out rather than burying it.
  const tip = fmt(order.tip);
  if (tip !== null) lines.push(L(pad("TIP (driver)", tip, cols), { bold: true }));

  const total = fmt(order.customer_total);
  if (total !== null) {
    lines.push(L(rule));
    lines.push(L(pad("TOTAL", total, cols), { bold: true, size: "double-h" }));
  }
  if (order.payment_type) lines.push(L(pad("Paid", String(order.payment_type), cols)));

  // --- notes ---
  if (order.notes) {
    lines.push(L(rule));
    lines.push(L("NOTE:", { bold: true }));
    for (const l of wrap(order.notes, cols)) lines.push(L(l, { bold: true }));
  }

  return lines;
}

// --- renderers --------------------------------------------------------------

const ESC = 0x1b, GS = 0x1d;

function toEscPos(lines, cols) {
  const chunks = [];
  const raw = (...b) => chunks.push(Buffer.from(b));
  const text = (s) => chunks.push(Buffer.from(s + "\n", "ascii"));

  raw(ESC, 0x40); // initialize
  for (const line of lines) {
    const body = line.text ?? "";
    // Double WIDTH halves the usable columns, so a long restaurant name would
    // run off the paper. Drop to double-height-only rather than truncate -
    // still emphasised, still legible, never clipped.
    const size =
      line.size === "double"
        ? body.length > Math.floor(cols / 2) ? 0x01 : 0x11
        : line.size === "double-h"
          ? 0x01
          : 0x00;

    raw(ESC, 0x61, line.align === "center" ? 1 : line.align === "right" ? 2 : 0);
    raw(ESC, 0x45, line.bold ? 1 : 0);
    raw(GS, 0x21, size); // GS ! n - high nibble width, low nibble height
    text(body);
  }
  raw(ESC, 0x61, 0);
  raw(ESC, 0x45, 0);
  raw(GS, 0x21, 0x00);
  raw(0x0a, 0x0a, 0x0a, 0x0a);       // feed clear of the cutter
  raw(GS, 0x56, 0x42, 0x00);         // partial cut
  return Buffer.concat(chunks);
}

const xmlEscape = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * Epson ePOS-Print XML (TM-m30III, TM-i series).
 *
 * These printers listen on 9100 but silently discard raw ESC/POS unless raw
 * mode is explicitly enabled - the job is accepted and blank paper comes out.
 * Their native protocol is this XML over HTTP, which is also what Server
 * Direct Print speaks, so this is the forward-looking transport.
 */
function toEposXml(lines, cols) {
  const body = lines
    .map((line) => {
      const t = line.text ?? "";
      const dbl = line.size === "double" && t.length <= Math.floor(cols / 2);
      const w = dbl ? 2 : 1;
      const h = line.size === "double" || line.size === "double-h" ? 2 : 1;
      const align = line.align === "center" ? "center" : line.align === "right" ? "right" : "left";
      return (
        `<text align="${align}" em="${line.bold ? "true" : "false"}" ` +
        `width="${w}" height="${h}">${xmlEscape(t)}&#10;</text>`
      );
    })
    .join("");

  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">
${body}<feed line="3"/><cut type="feed"/>
</epos-print>
</s:Body></s:Envelope>`;
}

async function sendViaEpos(lines) {
  const url = `http://${cfg.printerHost}:${cfg.eposPort}/cgi-bin/epos/service.cgi?devid=${cfg.eposDevId}&timeout=10000`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' },
    body: toEposXml(lines, cfg.cols),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ePOS HTTP ${res.status}`);
  // The printer answers 200 even when it refuses the job; success is in the body.
  if (!/success="true"/.test(text)) {
    const code = text.match(/code="([^"]*)"/)?.[1] || "unknown";
    throw new Error(`ePOS rejected the job (code="${code}")`);
  }
}

function toPlainText(lines) {
  return lines
    .map((l) => {
      const t = l.text ?? "";
      if (l.align === "center") {
        const padL = Math.max(0, Math.floor((cfg.cols - t.length) / 2));
        return " ".repeat(padL) + t;
      }
      return t;
    })
    .join("\n");
}

// --- transport (swap this function for Bluetooth later) ---------------------

/**
 * `lines` is the structured ticket; `bytes` is the same ticket already
 * rendered to ESC/POS. ePOS builds its own XML from the lines, so both are
 * passed and each transport takes what it needs.
 */
function sendToPrinter(bytes, lines) {
  if (cfg.transport === "epos") return sendViaEpos(lines);
  if (cfg.transport === "usb") return sendViaSystemPrinter(bytes);
  return sendViaTcp(bytes);
}

/** Run a command, feed it `input` on stdin, resolve on a clean exit. */
function run(cmd, argv, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv);
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) =>
      reject(new Error(`${cmd} could not be started: ${e.message}`))
    );
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`))
    );
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

/**
 * USB / locally-attached printer, via the operating system's print queue.
 *
 * The queue MUST be a raw/generic one. A driver queue (PostScript, Gutenprint,
 * an inkjet driver) will rasterise the bytes and emit garbage or blank paper -
 * ESC/POS has to reach the printer untouched, which is what `-o raw` ensures.
 */
async function sendViaSystemPrinter(bytes) {
  if (process.platform === "win32") {
    // Windows has no `lp`. Raw-copy to a shared queue: share the printer, then
    // set SYSTEM_PRINTER to the share name.
    const tmp = join(tmpdir(), `pfd-ticket-${Date.now()}.bin`);
    await writeFile(tmp, bytes);
    try {
      await run("cmd", ["/c", "copy", "/b", tmp, `\\\\localhost\\${cfg.systemPrinter}`]);
    } finally {
      await unlink(tmp).catch(() => {});
    }
    return;
  }
  const argv = ["-o", "raw"];
  if (cfg.systemPrinter) argv.unshift("-d", cfg.systemPrinter);
  await run("lp", argv, bytes);
}

function sendViaTcp(bytes) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(10000, () => done(new Error("printer connection timed out")));
    socket.on("error", done);
    socket.connect(cfg.printerPort, cfg.printerHost, () => {
      // Wait for the kernel to flush before closing, or the tail of a long
      // ticket can be dropped when the socket is destroyed too eagerly.
      socket.write(bytes, () => setTimeout(() => done(null), 300));
    });
  });
}

// --- API --------------------------------------------------------------------

const headers = () => ({
  "X-Device-Key": cfg.deviceKey,
  "X-App-Version": `print-agent/${cfg.agentVersion}`,
  "X-Printer-Name": cfg.printerName,
});

async function fetchJobs() {
  const res = await fetch(`${cfg.apiBase}/api/print/jobs`, { headers: headers() });
  if (res.status === 401) throw new Error("unauthorized - check PFD_DEVICE_KEY");
  if (!res.ok) throw new Error(`GET /api/print/jobs -> ${res.status}`);
  const body = await res.json();
  return body.jobs ?? [];
}

async function reportJob(jobId, status, error) {
  const res = await fetch(`${cfg.apiBase}/api/print/jobs`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, status, error: error?.slice(0, 500) }),
  });
  if (!res.ok) errlog(`report ${status} for ${jobId} -> ${res.status}`);
}

async function pollOnce() {
  const jobs = await fetchJobs();
  if (!jobs.length) return 0;
  log(`claimed ${jobs.length} job(s)`);

  for (const job of jobs) {
    const order = job.orders;
    if (!order) {
      // Job with no order attached is unprintable; fail it so it stops cycling.
      await reportJob(job.id, "failed", "job had no order payload");
      continue;
    }
    try {
      const lines = buildTicket(order, cfg.cols);
      await sendToPrinter(toEscPos(lines, cfg.cols), lines);
      await reportJob(job.id, "printed");
      log(`printed order #${order.order_number} (job ${job.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errlog(`print FAILED for order #${order.order_number}: ${msg}`);
      // Server re-queues up to 3 attempts before parking the job as failed.
      await reportJob(job.id, "failed", msg);
    }
  }
  return jobs.length;
}

// --- sample -----------------------------------------------------------------

const SAMPLE = {
  order_number: "7c753db5",
  source: "zuppler",
  ticket_restaurant_name: "Yummy Johns",
  order_type: "delivery",
  due_time: new Date(Date.now() + 40 * 60000).toISOString(),
  received_at: new Date().toISOString(),
  customer_name: "Mac Baggett",
  customer_phone: "6153473239",
  customer_address: "5432 Highway 76 East, Springfield, TN 37172",
  items: [
    { name: "Clear Soup", price: "$2.50", modifiers: [] },
    { name: "Edamame", price: "$4.95", modifiers: [] },
    { name: "Chicken Yaki Soba", price: "$11.95", modifiers: [] },
    { name: "2x Garden Salad", price: "$7.00", modifiers: ["Extra salad dressing"] },
    { name: "3x Pepper Tuna App", price: "$23.85", modifiers: ["Add wasabi and soy sauce with this order please"] },
  ],
  items_total: 50.25, tax: 4.9, service_fee: 14.57,
  delivery_fee: 6.06, tip: 11.37, customer_total: 87.15,
  payment_type: "CREDIT",
  notes: "Gate code 4482 | Leave at door",
};

// --- main -------------------------------------------------------------------

async function main() {
  if (args.has("--sample")) {
    console.log(toPlainText(buildTicket(SAMPLE, cfg.cols)));
    console.log("\n" + "=".repeat(cfg.cols));
    console.log(`${cfg.cols} columns | ${toEscPos(buildTicket(SAMPLE, cfg.cols), cfg.cols).length} bytes of ESC/POS`);
    return;
  }

  if (args.has("--test-print")) {
    // Prove the hardware path end to end without waiting for a real order.
    const dest = cfg.transport === "usb"
      ? `system printer "${cfg.systemPrinter || "(default)"}"`
      : cfg.transport === "epos"
        ? `ePOS ${cfg.printerHost}:${cfg.eposPort}`
        : `${cfg.printerHost}:${cfg.printerPort}`;
    log(`test print -> ${dest}`);
    const sampleLines = buildTicket(SAMPLE, cfg.cols);
    await sendToPrinter(toEscPos(sampleLines, cfg.cols), sampleLines);
    log("sent - check the paper");
    return;
  }

  const needed = cfg.transport === "usb" ? ["PFD_DEVICE_KEY"] : ["PFD_DEVICE_KEY", "PRINTER_HOST"];
  const missing = needed.filter((k) => !process.env[k]);
  if (missing.length) {
    errlog(`missing required env: ${missing.join(", ")}`);
    errlog("see print-agent/README.md");
    process.exit(1);
  }

  const dest = cfg.transport === "usb"
    ? `usb:${cfg.systemPrinter || "(system default)"}`
    : cfg.transport === "epos"
      ? `epos:${cfg.printerHost}:${cfg.eposPort}`
      : `tcp:${cfg.printerHost}:${cfg.printerPort}`;
  log(`agent ${cfg.agentVersion} | api=${cfg.apiBase} | ${dest} | ${cfg.cols} cols`);

  if (args.has("--once")) {
    // --once is the connectivity smoke test, so a misconfigured key or an
    // unreachable printer should read as one clear line, not a stack trace.
    try {
      const n = await pollOnce();
      log(n === 0 ? "no jobs queued" : `handled ${n} job(s)`);
    } catch (err) {
      errlog(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { log(`${sig} - shutting down`); stopping = true; });
  }

  while (!stopping) {
    try {
      await pollOnce();
    } catch (err) {
      // Network blips and API hiccups must never kill the loop - the printer
      // going quiet is the one failure a restaurant cannot detect on its own.
      errlog(`poll error: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

main().catch((err) => {
  errlog("fatal:", err);
  process.exit(1);
});
