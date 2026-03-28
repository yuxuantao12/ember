/*
 * EMBER — Base Station Firmware
 * Target: Arduino Nano (ATmega328P)
 *
 * Receives SensorPacket structs from 2 wearable nodes via NRF24L01,
 * serializes as JSON, outputs over USB Serial at 115200 baud.
 * Also listens for BUZZ:N commands from the laptop dashboard and
 * relays them to the target wearable via radio.
 *
 * Optionally forwards JSON to an ESP-01 on SoftwareSerial D3
 * for the WiFi bonus dashboard (see esp01_wifi_bonus/).
 *
 * Libraries required:
 *   - RF24 by TMRh20
 */

#include <SPI.h>
#include <RF24.h>
#include <SoftwareSerial.h>

// ── Configuration ──
#define RF_CHANNEL    108
#define NRF_CE_PIN    9
#define NRF_CSN_PIN   10
#define BUZZER_PIN    6
#define ESP_TX_PIN    3   // SoftwareSerial TX to ESP-01 RX (bonus feature)

// ── Data packet (must match wearable firmware exactly) ──
struct SensorPacket {
  uint8_t  nodeId;
  float    latitude;
  float    longitude;
  float    heading;
  uint8_t  gpsFix;
  uint8_t  alertFlag;
  uint8_t  batteryPct;
  uint16_t stationaryMs;
};

// ── Objects ──
RF24 radio(NRF_CE_PIN, NRF_CSN_PIN);
SoftwareSerial espSerial(255, ESP_TX_PIN); // RX unused (255 = no pin), TX on D3

// ── Pipe addresses ──
const byte addrA[] = "EMBA1";
const byte addrB[] = "EMBB2";

// ── State ──
unsigned long lastPacketTime[3] = {0, 0, 0}; // index by node ID
bool buzzerActive = false;
unsigned long buzzerOffTime = 0;

void setup() {
  Serial.begin(115200);
  Serial.println(F("{\"status\":\"EMBER base station starting\"}"));

  // Buzzer
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);
  delay(100);
  digitalWrite(BUZZER_PIN, LOW);

  // ESP-01 serial (bonus)
  espSerial.begin(115200);

  // NRF24L01
  if (!radio.begin()) {
    Serial.println(F("{\"error\":\"NRF24L01 HARDWARE FAIL\"}"));
    while (1) { digitalWrite(BUZZER_PIN, HIGH); delay(200); digitalWrite(BUZZER_PIN, LOW); delay(200); }
  }

  radio.setChannel(RF_CHANNEL);
  radio.setDataRate(RF24_250KBPS);
  radio.setPALevel(RF24_PA_MAX);
  radio.setRetries(15, 15);
  radio.setPayloadSize(sizeof(SensorPacket));

  // Open two reading pipes — one per wearable
  radio.openReadingPipe(1, addrA);
  radio.openReadingPipe(2, addrB);
  radio.startListening();

  Serial.println(F("{\"status\":\"Listening on pipes EMBA1, EMBB2\"}"));
}

void loop() {
  // ── Check for incoming radio data ──
  uint8_t pipeNum;
  if (radio.available(&pipeNum)) {
    SensorPacket pkt;
    radio.read(&pkt, sizeof(pkt));

    // Validate node ID
    if (pkt.nodeId == 1 || pkt.nodeId == 2) {
      lastPacketTime[pkt.nodeId] = millis();

      // Build JSON string
      String json = buildJson(pkt);

      // Send to laptop via USB Serial
      Serial.println(json);

      // Send to ESP-01 via SoftwareSerial (bonus)
      espSerial.println(json);

      // Trigger base buzzer if firefighter is alerting
      if (pkt.alertFlag) {
        buzzerActive = true;
        buzzerOffTime = millis() + 3000; // buzz for 3 seconds
      }
    }
  }

  // ── Check for commands from laptop dashboard ──
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd.startsWith("BUZZ:")) {
      uint8_t targetId = cmd.charAt(5) - '0';
      if (targetId == 1 || targetId == 2) {
        sendBuzzCommand(targetId);
        Serial.print(F("{\"ack\":\"BUZZ sent to node "));
        Serial.print(targetId);
        Serial.println(F("\"}"));
      }
    }
  }

  // ── Manage buzzer ──
  if (buzzerActive) {
    digitalWrite(BUZZER_PIN, (millis() / 300) % 2 == 0 ? HIGH : LOW);
    if (millis() > buzzerOffTime) {
      buzzerActive = false;
      digitalWrite(BUZZER_PIN, LOW);
    }
  }

  // ── Signal loss detection ──
  for (uint8_t id = 1; id <= 2; id++) {
    if (lastPacketTime[id] > 0 && (millis() - lastPacketTime[id]) > 10000) {
      // Haven't heard from this node in 10 seconds
      // Could trigger buzzer or send alert to dashboard
      // For now, the dashboard handles this via timeout
    }
  }
}

/**
 * Build a compact JSON string from a SensorPacket.
 * Uses String concatenation (acceptable for Nano at this data rate).
 */
String buildJson(SensorPacket &p) {
  String s = "{\"id\":";
  s += p.nodeId;
  s += ",\"lat\":";
  s += String(p.latitude, 6);
  s += ",\"lng\":";
  s += String(p.longitude, 6);
  s += ",\"heading\":";
  s += String(p.heading, 1);
  s += ",\"fix\":";
  s += p.gpsFix;
  s += ",\"alert\":";
  s += p.alertFlag;
  s += ",\"batt\":";
  s += p.batteryPct;
  s += ",\"stat\":";
  s += p.stationaryMs;
  s += "}";
  return s;
}

/**
 * Send a buzz command to a specific wearable node via radio.
 * Temporarily switches to TX mode, sends the command, then
 * returns to RX mode.
 */
void sendBuzzCommand(uint8_t targetId) {
  radio.stopListening();

  const byte* targetAddr = (targetId == 1) ? addrA : addrB;
  radio.openWritingPipe(targetAddr);

  // Send a simple 1-byte command (0xFF = buzz)
  uint8_t cmd = 0xFF;
  radio.write(&cmd, 1);

  // Return to listening mode
  radio.openReadingPipe(1, addrA);
  radio.openReadingPipe(2, addrB);
  radio.startListening();
}
