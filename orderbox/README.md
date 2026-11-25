# PFD Order Box firmware (Waveshare ESP32-S3-Touch-LCD-7 + Eatabit EP-300 printer)

**Status: 1.0.0 builds; not yet run on a real board.** First boot needs checking:
picture timing, touch direction, buzzer pin.

## Flashing (first time, USB)
- ESP32-S3 bootloader is at **0x0** for the full image: flash `pfd-orderbox-1.0.0-full.bin` at **0x0**.
- Hold BOOT, tap RESET, release BOOT, then Connect in the web flasher.
- After that it updates itself (Product=orderbox on /api/print/firmware; releases go in
  pfd-order-monitor `public/firmware/orderbox/` + `lib/printers/orderbox-firmware-plan.json`).

## Wiring
- Printer TTL: board UART terminal, GPIO43 = TX to printer RX, GPIO44 = RX from printer TX, GND. 19200 baud.
- Buzzer: active 5V buzzer on GPIO6 (Sensor AD header) and GND. Changeable on the settings page.
- Power: 12V supply to the printer; 12V-to-5V USB-C step-down into the board.

## Things to check on first boot
1. Picture: if it rolls, shifts or flickers, adjust PANEL_* timing in `src/board.h`.
2. Touch: tap a button; if taps land in the wrong place, the mapping in `mapTouch()` needs flipping.
3. Orientation: settings page, Screen orientation (portrait / upside down).
4. Buzzer pin: settings page, Printer wiring.

## Screens
WiFi setup (join PFD-Box-XXXX) -> pair code -> today's orders -> NEW ORDER (edge glows, beeps until GOT IT) -> prep time.
