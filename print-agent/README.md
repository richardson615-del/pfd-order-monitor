# PFD print agent

Prints incoming orders to a **network (LAN) ESC/POS receipt printer** such as
the NETUM NS8360 / NT-8360.

Vercel cannot reach a printer sitting behind the restaurant's router, so this
agent runs *on the restaurant's network* and pulls work instead:

```
GET  /api/print/jobs   claim queued jobs + order data
     render ESC/POS -> TCP printer:9100
POST /api/print/jobs   report "printed" | "failed"
```

Zero dependencies. Node 18+ only.

---

## 1. Register the device

In the app, as an admin:

```
POST /api/admin/print-devices   { "restaurant_id": "...", "name": "Kitchen printer" }
```

The response contains `device_key` (`PFD-XXXX-XXXX-XXXX`). **It is shown once.**
Rotate by creating a new device.

## 2. Find the printer's IP

Most NETUM/generic LAN printers print their IP on a self-test page - hold FEED
while powering on. Give the printer a **DHCP reservation** on the router;
if its IP changes the agent silently stops printing.

Confirm it is reachable and listening:

```bash
nc -vz 192.168.1.50 9100
```

## 3. Configure

Two transports. **TCP is preferred** - a network printer keeps any host PC out
of the critical path, so printing does not stop because a computer slept, was
logged out, or had its cable pulled.

**A. Network printer (TCP 9100)**

```bash
export PFD_DEVICE_KEY="PFD-XXXX-XXXX-XXXX"
export PRINTER_HOST="192.168.1.50"
export PRINTER_PORT=9100          # optional
```

**B. Epson ePOS-Print printer (TM-m30III, TM-i series)**

```bash
export PFD_DEVICE_KEY="PFD-XXXX-XXXX-XXXX"
export PRINTER_TRANSPORT=epos
export PRINTER_HOST="EPSONB6AA2A.local"   # or its IP
```

> These printers **open port 9100 but silently discard raw ESC/POS** unless raw
> mode is enabled - the job is accepted and blank paper comes out, which is a
> confusing failure. Their native protocol is ePOS-Print XML over HTTP, which
> this transport speaks. It is also what Server Direct Print uses.

Using the Bonjour name (`EPSONxxxxxx.local`) instead of an IP means the printer
survives a DHCP reassignment. Requires mDNS on the agent's host - native on
macOS, `avahi-daemon` on Linux/Raspberry Pi.

**C. USB printer attached to this machine (OS print queue)**

```bash
export PFD_DEVICE_KEY="PFD-XXXX-XXXX-XXXX"
export PRINTER_TRANSPORT=usb
export SYSTEM_PRINTER="STMicroelectronics_POS80_Printer_USB"
```

List available queues with `lpstat -p` (macOS/Linux) or `wmic printer get name`
(Windows). Setting `SYSTEM_PRINTER` selects the `usb` transport automatically.

> **The queue must be raw/generic.** A driver queue (PostScript, Gutenprint, an
> inkjet driver) rasterises the bytes and yields garbage or blank paper. ESC/POS
> must reach the printer untouched - which is what `lp -o raw` does. On Windows,
> share the printer and set `SYSTEM_PRINTER` to the **share name**.

**Common options**

```bash
export PFD_API_BASE="https://pfd-order-monitor.vercel.app"
export POLL_INTERVAL_MS=5000
export PAPER_COLS=48        # 80mm = 48, 58mm = 32
export PRINTER_NAME="NS8360"
```

`PRINTER_NAME` and the agent version are sent as headers and surface on the
device row in `/admin`, along with `last_seen_at` - so the admin page shows
whether the agent is alive without extra plumbing.

## 4. Run

```bash
node agent.mjs --sample      # render a sample ticket to stdout, no printer
node agent.mjs --test-print  # print a sample ticket on the real printer
node agent.mjs --once        # one poll cycle then exit
node agent.mjs               # the poll loop
```

In order: `--sample` checks the layout, `--test-print` proves the hardware and
transport, `--once` proves the device key and API path. Then run the loop.

### Run it as a service (Linux / Raspberry Pi)

Copy `pfd-print-agent.service` to `/etc/systemd/system/`, edit the paths and
environment, then:

```bash
sudo systemctl enable --now pfd-print-agent
journalctl -u pfd-print-agent -f
```

---

## Behaviour worth knowing

- **At-least-once, never twice.** `GET` claims jobs atomically, so double
  polling cannot print a job twice. A job stuck `claimed` for >2 minutes is
  re-offered (agent died mid-print); the `(order_id, device_id)` unique
  constraint stops duplicate rows.
- **Failures retry.** A print error is reported as `failed`; the server
  re-queues up to 3 attempts, then parks the job as `failed` for admin
  visibility.
- **The loop never dies on a network blip.** A printer going quiet is the one
  failure a restaurant cannot notice on its own, so poll errors are logged and
  the loop continues.
- **The tip is printed as its own line, labelled `TIP (driver)`** - it is the
  driver's money and must not be buried inside the total.

## Ticket width

80mm at Font A is **48 columns**; 58mm is **32**. Everything (wrapping, the
right-flushed price column, double-width headings) is derived from `PAPER_COLS`,
and both widths are exercised by `--sample`. Double-width lines automatically
fall back to double-height when they would run off the paper.

## Switching to a Bluetooth printer later

Only `sendToPrinter()` is transport-specific - it opens a TCP socket and writes
the ESC/POS buffer. A Bluetooth printer means replacing that one function with
an SPP write (and setting `PAPER_COLS=32` for a 58mm unit). The ticket renderer,
polling, claiming and reporting are all unchanged.

Note that Node cannot speak Bluetooth Classic SPP without a native module; on a
phone that work belongs in an Android app, which would reuse this same API
contract rather than this script.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `unauthorized - check PFD_DEVICE_KEY` | Key wrong, or the device row is `is_active = false` |
| `printer connection timed out` | Wrong IP, printer asleep, or not listening on 9100 |
| Jobs claimed but nothing prints | TCP: printer on a different subnet/VLAN. USB: check `lpstat -o` for a stuck job |
| Nothing ever claimed | No `print_devices` row for that restaurant, or no orders since it was created |
| Garbage characters / blank paper (USB) | Queue is not raw - reinstall it with a Generic/Raw driver |
| `lp could not be started` | Not macOS/Linux, or CUPS not installed |
| Epson: job accepted, **blank paper** | Raw ESC/POS on 9100 - use `PRINTER_TRANSPORT=epos` |
| `ePOS rejected the job (code=...)` | Cover open, out of paper, or a malformed ticket |
| Ticket tail cut off | Raise the post-write delay in `sendViaTcp()` |

**Print jobs are queued at ingest time**, so orders that arrived *before* the
device was registered will never print. Use `--test-print`, or ingest a new
order, when validating.
