# PFD Order Box firmware 1.1.2 (Waveshare ESP32-S3-Touch-LCD-7 + Eatabit EP-300 printer)

**Status:** 1.1.2 builds, and every screen and its logic are tested on a computer (below). It has not run on a real board yet. On first boot, check the picture timing, the touch direction and the buzzer pin.

## What the box does
- **New order:** the ticket prints and the edge of the screen glows. The box beeps until someone taps **GOT IT**, which accepts the order at the restaurant's prep time (busy time included). Uber Eats orders show **ACCEPT** / **Deny** instead. Deny asks for a reason (too busy, item out, closing, other), then the CRM refuses the order with Uber.
- **Missed order:** after 2 minutes with no tap, the screen goes red and the box beeps every 2 seconds. Dispatch gets the "order not acknowledged" alert.
- **Home:** open orders, oldest first. Each one shows:
  - its ready timer (amber under 5 minutes, red when late)
  - the driver and their ETA ("Mike, 6 min away", "Mike is here")
  - an Uber Eats stripe
- **Order:**
  - READY
  - +5 / +10 min
  - change the ready time
  - reprint
  - tell dispatch: "Missing item", "Pickup here", "Driver?"
- **Toolbar:**
  - **Busy:** add 10/15/20/30 min for 30 min, 1 hour or 2 hours.
  - **Pause:** stop online orders for 15/30/60/120 minutes or the rest of today.
  - **Msgs:** dispatch's replies, plus quick messages.
  - **86:** sold out for today, or back on.
  - **Today:** orders, food sales, average order and most-ordered item.
- **Idle screen:** shows after 3 minutes with nothing open: a big clock, today's orders and the restaurant's promo line (set in the CRM).
- **Printer paper:** the box reads the EP-300 paper sensor every minute. Low paper or out of paper shows on the screen, in the CRM and on the tablet.
- **Remote tools (CRM Equipment, the device page):** reboot, screenshot (shown on that page) and reprint an order by number.
- **Backup internet:** enter a hotspot or LTE router on the settings page. If the store WiFi is down for a minute, the box switches to the backup, and switches back when the store WiFi returns.

## Flashing (first time, USB)
- Flash `pfd-orderbox-1.1.2-full.bin` at **0x0**. Hold BOOT, tap RESET, release BOOT, then Connect in the web flasher.
- After that, it updates itself (Product=orderbox on /api/print/firmware). Releases go in pfd-order-monitor `public/firmware/orderbox/` and `lib/printers/orderbox-firmware-plan.json`.

## Wiring
- **Printer TTL:** the board's UART terminal. GPIO43 = TX to the printer's RX, GPIO44 = RX from the printer's TX, plus GND. 19200 baud. The RX wire is what makes the paper sensor work.
- **Buzzer:** an active 5V buzzer on GPIO6 (Sensor AD header) and GND. The pin can be changed on the settings page.
- **Power:** a 12V supply to the printer, and a 12V-to-5V USB-C step-down into the board.
- No free GPIO is left for a cellular modem (the RS485 and CAN pins go through transceivers). That's why backup internet is a second WiFi (an LTE hotspot) and not a modem.

## Things to check on first boot
1. **Picture:** if it rolls, shifts or flickers, adjust the PANEL_* timing in `src/board.h`.
2. **Touch:** tap a button. If taps land in the wrong place, flip the mapping in `mapTouch()`.
3. **Orientation:** settings page, Screen orientation.
4. **Buzzer:** settings page, Printer wiring (pin).
5. **Screenshot:** take one from the CRM device page and check it is the right way up.

## Tests (run on a computer)
- `g++ -std=c++17 test/host_test.cpp && ./a.out` runs the logic: 45 checks. It covers parsing the server reply, timers, driver lines, the menu, screenshot encoding and rotation, backup WiFi switching, and paper status.
- `tools/render_screens.sh out/` compiles the real `ui.h` against a pixel canvas. It draws every screen (`screens/`) and taps through the flows: 30 checks. Those checks cover which server call each button makes, that no buttons overlap and that every button is on screen.
- `test/e2e_test.cpp` parses replies produced by the bridge's real handlers (`test/fixtures/`): 11 checks.
- Bridge side: pfd-order-monitor `scripts/test-orderbox.ts` (24 checks).
