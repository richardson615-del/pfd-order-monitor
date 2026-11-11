# Flashing a PFD Eatabit printer (firmware 2.8.3)

One-time USB flash per box. After this, updates go over WiFi from the printer's own page.

## You need
- Eatabit board 112-P01 Rev A (ESP32-WROOM-32D), with its own power supply
- USB-serial adapter set to **3.3V** (FTDI FT232R is what we used; never 5V)
- 3 jumper wires, a multimeter with beep mode
- Chrome on a computer (Mac or Windows; on Windows the adapter needs its USB-serial driver)
- `pfd-eatabit-2.8.3-full.bin` (this folder)

## 1. Open the box and find the programming pads
- Do **not** use the 6-pin socket marked GND/5V0/NC/NC/RXD/TXD. That is the printer's port, not the ESP32's.
- Flip the board. **JP1, labeled ICSP**, is the programming port: 6 small pads with 4 holes around them.
- TX (ESP32 TXD0) is the **middle-bottom** ICSP pad. RX (ESP32 RXD0) is the **middle-top** pad.
- SW1 is reset, SW2 is boot.
- Solder or tape the two wires to the pads. Holding them by hand drops the connection partway through the write.

## 2. Wire it
- Adapter **RX** -> ICSP TX pad (middle bottom)
- Adapter **TX** -> ICSP RX pad
- Adapter **GND** -> any GND (the GND pin of the printer socket works)
- Nothing on the adapter's 3V3/5V. The board runs on its own supply.
- Holding wire ends on the pads works; a dab of solder is steadier.

## 3. Flash
1. Plug in the board's power and the adapter's USB.
2. Open https://espressif.github.io/esptool-js/ in Chrome.
3. Set **Baudrate to 115200** (faster speeds fail with "serial noise" on jumper wires).
4. Push the board's power plug **all the way in**. A loose plug makes the board brown out: white screen, endless restarts, no setup WiFi.
5. Put the board in flash mode: hold **SW2**, press and release **SW1**, then let go of SW2. To confirm, the Console section at 115200 shows "waiting for download" after this.
6. Click **Connect**, pick the adapter (FT232R USB UART / usbserial / CP210x / CH340). It should report ESP32-D0WD and 4MB flash. If it fails, redo step 4 releasing SW2 first, or swap TX/RX.
7. Flash address **0x0**, choose `pfd-eatabit-2.8.3-full.bin`, tick **Erase flash**, click **Program**. About 2 minutes. Keep the wires still.
8. Check the log ends with "Hash of data verified". Disconnect, remove the wires, unplug power for 5 seconds and plug back in.

## 4. Put it on WiFi
1. The screen shows **WIFI SETUP**. On a phone, join WiFi **PFD-Printer-XXXX** (the name is on the screen).
2. The setup page opens (or go to 192.168.4.1). It lists the WiFi networks the printer can hear, strongest first (give it a few seconds on "Looking for WiFi networks"). Tap the restaurant's WiFi, type the password, Save. Only 2.4 GHz networks show. "Other" lets you type a hidden network's name.
3. It restarts and joins. The screen shows **PAIR PRINTER** with a six-digit code.

## 5. Pair it in the CRM
CRM -> **Equipment** -> **Add printer** -> pick the restaurant -> type the six-digit **pair code** -> **Pair printer**.
Within seconds the printer shows PAIRED, prints PRINTER ONLINE, and starts printing that restaurant's orders. No key to copy.
Then open the printer in Equipment and press **Test print**.

## Two board versions
There are two Eatabit boards. The firmware detects which one on first boot and sets everything itself.
- **Board A** (red): screen on 17/16/0/2, reset via GPIO 15; buttons on 14/33/27/32.
- **Board B** (black, TCA9534 chip by the buzzer): screen SCLK 15, MOSI 23, CS 4, A0 2, RST 0; buttons through the TCA9534 at I2C 0x20 (SDA 14, SCL 27); ring is addressable LEDs on GPIO 12. All detected and set on first boot.
If the screen stays white after flashing, unplug the power for 5 seconds and plug back in.

## When something goes wrong
| What you see | What it means / what to do |
|---|---|
| Flasher log says **Flash ID: ffffff** and "Failed to communicate with the flash chip" | Black boards with an **ESP32-WROOM-32E** module: pin 12 is held high at reset. Enter flash mode with a bridge: hold SW2, short the two pins at the **bottom-left corner** of the silver module (last pin of the left row = IO12, first pin of the bottom row = GND) with tweezers or a wire, tap SW1, release SW2, remove the bridge, then Connect. The Flash ID then reads normally (e.g. 16405e). Also **untick Erase all** on these boards: the full erase times out ("serial noise"); the write clears what it needs. After flashing they boot normally with no bridge. (Proven 2026-11-10.) |
| Screen stays **white** or no **PFD-Printer-XXXX** network | Push the power plug in fully, unplug 5 s, plug back in. Still nothing: leave the flash wires on, open the flasher's **Console** at 115200, click Start, tap SW1 and read the boot log. Lines of `rst:0x1 (POWERON_RESET)` that never reach "pfd-eatabit ... booting" = power problem. |
| Connect fails / "No port selected" | Click Connect yourself (the port picker needs a real click), pick the port. If the flasher was used for a previous board, reload the page first so it lets go of the port. |
| Write stops partway | Wire moved. Re-enter flash mode, reload the flasher, try again at 115200. |
| Buttons do nothing on an older box | It's on old firmware. Upload the update bin from its settings page (`/update`). |

## Notes
- Printer head: GPIO 22 @ 19200, screen reset 15, buttons 14/33/27/32 (UP/DOWN/MENU/PRINT), ring R25 G26 B12. All built in.
- Box settings page: http://pfd-printer-XXXX.local/ (or its IP, shown under MENU -> Printer info). Firmware updates: upload `pfd-eatabit-x.y.z-update.bin` at `/update` on that page.
- On the box: UP/DOWN = today's orders, PRINT = reprint, MENU = settings (lights, WiFi) or prep time on an order.
