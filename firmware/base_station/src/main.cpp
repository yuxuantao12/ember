#include <SPI.h>
#include <RF24.h>
#include <avr/wdt.h>

// Using channel 108 to stay clear of the noisier low-end WiFi frequencies
#define RF_CHANNEL   108
#define NRF_CE_PIN   9
#define NRF_CSN_PIN  10
#define BUZZER_PIN   6

// This struct is the "handshake" between the nodes and this base station.
// __attribute__((packed)) ensures no sneaky padding is added by the compiler,
// so the bytes align perfectly over the air.

struct __attribute__((packed)) SensorPacket {
  uint8_t  nodeId;
  float    latitude;
  float    longitude;
  float    heading;
  uint8_t  gpsFix;
  uint8_t  alertFlag;
  uint8_t  batteryPct;
  uint16_t stationaryMs;
  float    drLat;
  float    drLng;
  uint8_t  pinDrop;
};

RF24 radio(NRF_CE_PIN, NRF_CSN_PIN);

// Hardcoded addresses for our two main nodes (only one node implemented)
const byte addrA[] = "EMBB1";
const byte addrB[] = "EMBB2";

unsigned long lastPacketTime[3] = {0, 0, 0};
bool buzzerActive = false;
unsigned long buzzerOffTime = 0;

// Prototypes for the helpers below
String buildJson(SensorPacket &p);
void sendBuzzCommand(uint8_t targetId);

void setup() {
  wdt_disable();
  Serial.begin(115200);
  Serial.println(F("{\"status\":\"EMBER base station starting\"}"));

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);
  delay(100);
  digitalWrite(BUZZER_PIN, LOW);

  if (!radio.begin()) {
    Serial.println(F("{\"error\":\"NRF HARDWARE FAIL\"}"));
    while (1) {
      digitalWrite(BUZZER_PIN, HIGH); delay(200);
      digitalWrite(BUZZER_PIN, LOW);  delay(200);
    }
  }

// Radio fine-tuning: 250KBPS gives us the best possible range
  radio.setChannel(RF_CHANNEL);
  radio.setDataRate(RF24_250KBPS);
  radio.setPALevel(RF24_PA_MAX);
  radio.setRetries(15, 15);
  radio.setPayloadSize(sizeof(SensorPacket));

// Listen for both nodes simultaneously on different pipes
  radio.openReadingPipe(1, addrA);
  radio.openReadingPipe(2, addrB);
  radio.startListening();

  Serial.println(F("{\"status\":\"Listening on EMBB1 and EMBB2\"}"));
  wdt_enable(WDTO_2S);
}

void loop() {
  wdt_reset();
  uint8_t pipeNum = 0;

// Check if any node has sent a status update
  if (radio.available(&pipeNum)) {
    SensorPacket pkt;
    radio.read(&pkt, sizeof(pkt));

// We use the pipe number as the ID to verify which node sent what
    pkt.nodeId = pipeNum;
    lastPacketTime[pkt.nodeId] = millis();
    Serial.println(buildJson(pkt));

  }

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

  if (buzzerActive) {
    digitalWrite(BUZZER_PIN, (millis() / 300) % 2 == 0 ? HIGH : LOW);
    if (millis() > buzzerOffTime) {
      buzzerActive = false;
      digitalWrite(BUZZER_PIN, LOW);
    }
  }
}

// Converts the raw struct into a JSON string for easy parsing by external software
String buildJson(SensorPacket &p) {
  //Alert name
  const char* alertName;
  switch (p.alertFlag) {
    case 0:  alertName = "null";    break;
    case 1:  alertName = "stationary";   break;
    case 2:  alertName = "survivor";     break;
    case 3:  alertName = "no_survivor";  break;
    case 4:  alertName = "danger";       break;
    default: alertName = "unknown";      break;
  }

  String s = "{\"id\":";
  s += p.nodeId;
  s += ",\"lat\":";      s += String(p.latitude,  6);
  s += ",\"lng\":";      s += String(p.longitude, 6);
  s += ",\"heading\":";  s += String(p.heading,   1);
  s += ",\"fix\":";      s += p.gpsFix;
  s += ",\"alert\":";    s += p.alertFlag;
  s += ",\"alertName\":\""; s += alertName; s += "\"";
  s += ",\"batt\":";     s += p.batteryPct;
  s += ",\"stat\":";     s += p.stationaryMs;
  s += ",\"pin\":";      s += p.pinDrop;
  s += ",\"drLat\":";    s += String(p.drLat, 6);
  s += ",\"drLng\":";    s += String(p.drLng, 6);
  s += "}";
  return s;
}

// Switches from "Listening" to "Talking" mode to send a command back to a node
void sendBuzzCommand(uint8_t targetId) {
  radio.stopListening();
  const byte* addr = (targetId == 1) ? addrA : addrB;
  radio.openWritingPipe(addr);
  uint8_t cmd = 0xFF;
  radio.write(&cmd, 1);

// Return to listening mode so we don't miss the next update
  radio.openReadingPipe(1, addrA);
  radio.openReadingPipe(2, addrB);
  radio.startListening();
}
