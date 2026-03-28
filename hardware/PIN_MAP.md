# EMBER Hardware Pin Map — Arduino Nano

## Wearable Node (×2)

| Nano Pin | Connected To       | Protocol          | Wire Color (suggested) |
|----------|--------------------|-------------------|------------------------|
| D0 (RX)  | USB (reserved)     | Hardware UART     | — do not connect —     |
| D1 (TX)  | USB (reserved)     | Hardware UART     | — do not connect —     |
| D2       | *unassigned*       | —                 |                        |
| D3       | GPS TX             | SoftwareSerial RX | White                  |
| D4       | GPS RX             | SoftwareSerial TX | Gray                   |
| D5       | *unassigned*       | —                 |                        |
| D6       | Buzzer (+)         | Digital Output    | Yellow                 |
| D7       | *unassigned*       | —                 |                        |
| D8       | *unassigned*       | —                 |                        |
| D9       | NRF24L01 CE        | Digital Output    | Orange                 |
| D10      | NRF24L01 CSN       | SPI SS            | Brown                  |
| D11      | NRF24L01 MOSI      | SPI MOSI          | Green                  |
| D12      | NRF24L01 MISO      | SPI MISO          | Blue                   |
| D13      | NRF24L01 SCK       | SPI SCK           | Purple                 |
| A0–A3    | *unassigned*       | —                 |                        |
| A4       | IMU SDA            | I2C Data          | White (twisted pair)   |
| A5       | IMU SCL            | I2C Clock         | Yellow (twisted pair)  |
| A6–A7    | *unassigned*       | Analog only       |                        |
| 5V       | IMU VCC, GPS VCC   | Power             | Red                    |
| 3.3V     | NRF24L01 VCC + Cap | Power             | Red (3.3V rail)        |
| GND      | All GNDs + Cap −   | Ground            | Black                  |

**Critical:** 10µF capacitor across NRF24L01 VCC and GND, as close to the module as possible.

---

## Base Station (×1)

| Nano Pin | Connected To       | Protocol          | Notes                  |
|----------|--------------------|-------------------|------------------------|
| D0 (TX)  | USB → Laptop       | Hardware UART     | JSON data at 115200    |
| D1 (RX)  | USB ← Laptop       | Hardware UART     | BUZZ commands from dashboard |
| D3       | ESP-01 RX (BONUS)  | SoftwareSerial TX | Via voltage divider (1K+2K) |
| D6       | Buzzer (+)         | Digital Output    |                        |
| D9       | NRF24L01 CE        | Digital Output    |                        |
| D10      | NRF24L01 CSN       | SPI SS            |                        |
| D11      | NRF24L01 MOSI      | SPI MOSI          |                        |
| D12      | NRF24L01 MISO      | SPI MISO          |                        |
| D13      | NRF24L01 SCK       | SPI SCK           |                        |
| 3.3V     | NRF24L01 VCC + Cap (+ ESP-01 VCC if bonus) | Power |             |
| GND      | All GNDs           | Ground            |                        |

---

## ESP-01 Bonus (base station only)

| ESP-01 Pin | Connected To              | Notes                              |
|------------|---------------------------|------------------------------------|
| VCC        | Nano 3.3V                 | 3.3V ONLY                          |
| GND        | Nano GND                  |                                    |
| RX         | Nano D3 via voltage divider | 1K from D3 → ESP RX, 2K from ESP RX → GND |
| TX         | Not connected             |                                    |
| CH_PD (EN) | 3.3V via 10K pullup       | Must be HIGH to run                |
| GPIO0      | 3.3V via 10K pullup       | HIGH = run mode, LOW = flash mode  |
| GPIO2      | Not connected             |                                    |
| RST        | 3.3V via 10K pullup       | Prevent accidental resets          |

---

## NRF24L01 Module Pinout (8 pins, top view)

```
         ┌─────────────┐
    GND  │ 1    2      │  VCC (3.3V!)
     CE  │ 3    4      │  CSN
    SCK  │ 5    6      │  MOSI
   MISO  │ 7    8      │  IRQ (not used)
         └─────────────┘
```

**Pin 2 (VCC) = 3.3V ONLY. Connecting to 5V will permanently destroy the module.**
