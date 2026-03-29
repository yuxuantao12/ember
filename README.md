# EMBER — Emergency Monitor for Building Evacuation and Rescue

> Real-time firefighter tracking system for incident commanders. Built for a 24-hour hackathon.

![Status](https://img.shields.io/badge/status-hackathon_prototype-orange)
![Hardware](https://img.shields.io/badge/hardware-Arduino_Nano-blue)
![Radio](https://img.shields.io/badge/radio-NRF24L01_2.4GHz-green)

## What is EMBER?

EMBER tracks firefighters inside buildings in real time. Each firefighter wears a sensor node that broadcasts their GPS position and heading via NRF24L01 radio to a base station outside the building. The base station forwards data over USB serial to a laptop running a browser-based dashboard that overlays firefighter positions on an uploaded floor plan.

```
┌─────────────┐     ┌─────────────┐
│ Wearable A  │     │ Wearable B  │
│ Nano+GPS+IMU│     │ Nano+GPS+IMU│
└──────┬──────┘     └──────┬──────┘
       │  2.4 GHz Radio    │
       └────────┬──────────┘
                │
       ┌────────┴────────┐
       │  Base Station   │
       │  Nano+NRF24L01  │
       └────────┬────────┘
                │ USB Serial
       ┌────────┴────────┐
       │ Laptop Dashboard│
       │ Chrome/Edge     │
       └─────────────────┘
```

## Project Structure

```
ember/
├── dashboard/              # Browser-based tracking dashboard (CS person)
│   ├── index.html          # Main entry point — open in Chrome
│   ├── css/
│   │   └── styles.css      # All styles — dark fire-themed UI
│   └── js/
│       ├── app.js           # Init, state management, UI updates
│       ├── serial.js        # Web Serial API connection layer
│       ├── canvas.js        # Floor plan rendering + firefighter markers
│       ├── calibration.js   # GPS-to-pixel coordinate mapping
│       └── mock.js          # Fake data generator for development
│
├── firmware/               # Arduino sketches (CE person)
│   ├── wearable_node/      # Wearable firefighter node firmware
│   │   └── wearable_node.ino
│   ├── base_station/       # Base station receiver firmware
│   │   └── base_station.ino
│   └── esp01_wifi_bonus/   # BONUS: ESP-01 WiFi dashboard
│       └── esp01_wifi_bonus.ino
│
├── hardware/               # Wiring diagrams and pin maps (EE person)
│   └── PIN_MAP.md          # Complete pin assignments for all units
│
├── docs/                   # Build guide and documentation
│   └── EMBER_Nano_Build_Guide.docx
│
└── README.md               # This file
```

## Hardware Requirements

| Component | Qty | Purpose |
|-----------|-----|---------|
| Arduino Nano | 3 | Main controller for all units |
| NRF24L01 (standard) | 3 | 2.4 GHz radio (1 per Nano) |
| IMU (MPU6050/9250) | 2 | Heading/orientation (wearables only) |
| GPS (NEO-6M) | 2 | Position tracking (wearables only) |
| Active Buzzer | 3 | Audible alerts (1 per unit) |
| 10µF Capacitor | 3 | NRF24L01 power stabilization |
| ESP-01 (ESP8266) | 1 | BONUS: WiFi phone dashboard |

## Quick Start

### Dashboard (no hardware needed)
1. Open `dashboard/index.html` in **Chrome** or **Edge**
2. Click **Mock Data** to simulate two firefighters
3. Click **Upload Floor Plan** to load a building image
4. Click **Calibrate** to set GPS-to-pixel mapping

### With Hardware
1. Flash `firmware/wearable_node/wearable_node.ino` to wearable Nanos
2. Flash `firmware/base_station/base_station.ino` to base station Nano
3. Connect base station to laptop via USB
4. Open `dashboard/index.html` in Chrome
5. Click **Connect** and select the Nano's serial port

## Pin Map (Arduino Nano)

| Pin | Wearable | Base Station |
|-----|----------|--------------|
| D3 | GPS TX (SoftwareSerial RX) | ESP-01 RX (bonus) |
| D4 | GPS RX (SoftwareSerial TX) | — |
| D6 | Buzzer + | Buzzer + |
| D9 | NRF24L01 CE | NRF24L01 CE |
| D10 | NRF24L01 CSN | NRF24L01 CSN |
| D11 | NRF24L01 MOSI | NRF24L01 MOSI |
| D12 | NRF24L01 MISO | NRF24L01 MISO |
| D13 | NRF24L01 SCK | NRF24L01 SCK |
| A4 | IMU SDA | — |
| A5 | IMU SCL | — |
| 3.3V | NRF24L01 VCC | NRF24L01 VCC |
| 5V | IMU VCC, GPS VCC | — |

## Serial Protocol

Base station sends JSON lines at 115200 baud:
```json
{"id":1,"lat":29.6516,"lng":-82.3248,"heading":135.2,"fix":1,"alert":0,"batt":87,"stat":0}
```

Dashboard can send commands back:
```
BUZZ:1    // Alert firefighter 1
BUZZ:2    // Alert firefighter 2
```

## Team Roles

- **EE** — Soldering, wiring, 3D enclosures, hardware debugging
- **CE** — All Arduino firmware, radio config, serial protocols
- **CS** — Browser dashboard, Web Serial API, UI/UX

## Browser Support

The dashboard uses the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) which is supported in:
- ✅ Chrome 89+
- ✅ Edge 89+
- ❌ Firefox (not supported)
- ❌ Safari (not supported)

## License

MIT
