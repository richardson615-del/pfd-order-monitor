# Flashing a PFD Eatabit printer (firmware 2.7.0)

One-time USB flash per box. After this, updates go over WiFi from the printer's own page.

## You need
- Eatabit board 112-P01 Rev A (ESP32-WROOM-32D), with its own power supply
- USB-serial adapter set to **3.3V** (FTDI FT232R is what we used; never 5V)
- 3 jumper wires, a multimeter with beep mode
- Chrome on a computer
- `pfd-eatabit-2.7.0-full.bin` (this folder)

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
4. Put the board in flash mode: hold **SW2**, press and release **SW1**, then let go of SW2. To confirm, the Console section at 115200 shows "waiting for download" after this.
5. Click **Connect**, pick the adapter (FT232R USB UART / usbserial / CP210x / CH340). It should report ESP32-D0WD and 4MB flash. If it fails, redo step 4 releasing SW2 first, or swap TX/RX.
6. Flash address **0x0**, choose `pfd-eatabit-2.7.0-full.bin`, tick **Erase flash**, click **Program**. About 2 minutes. Keep the wires still.
7. Disconnect, remove the wires, unplug power for 5 seconds and plug back in.

## 4. Put it on WiFi
1. The screen shows **WIFI SETUP**. On a phone, join WiFi **PFD-Printer-XXXX** (the name is on the screen).
2. The setup page opens (or go to 192.168.4.1). Pick the restaurant's WiFi, type the password, Save.
3. It restarts and joins. The screen shows **PAIR PRINTER** with a six-digit code.

## 5. Pair it in the CRM
CRM -> **Equipment** -> **Add printer** -> pick the restaurant -> type the six-digit **pair code** -> **Pair printer**.
Within seconds the printer shows PAIRED, prints PRINTER ONLINE, and starts printing that restaurant's orders. No key to copy.
Then open the printer in Equipment and press **Test print**.

## Two board versions
There are two Eatabit boards. The firmware detects which one on first boot and sets everything itself.
- **Board A** (red): screen on 17/16/0/2, reset via GPIO 15; buttons on 14/33/27/32.
- **Board B** (black, TCA9534 chip by the buzzer): screen SCLK 15, MOSI 23, CS 4, A0 2, RST 0; buttons through the TCA9534 at I2C 0x20 (SDA 14, SCL 27).
If the screen stays white after flashing, unplug the power for 5 seconds and plug back in.

## Notes
- Printer head: GPIO 22 @ 19200, screen reset 15, buttons 14/33/27/32 (UP/DOWN/MENU/PRINT), ring R25 G26 B12. All built in.
- Box settings page: http://pfd-printer-XXXX.local/ (or its IP, shown under MENU -> Printer info). Firmware updates: upload `pfd-eatabit-x.y.z-update.bin` at `/update` on that page.
- On the box: UP/DOWN = today's orders, PRINT = reprint, MENU = settings (lights, WiFi) or prep time on an order.
