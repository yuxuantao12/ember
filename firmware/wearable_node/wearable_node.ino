/*
 * EMBER — Wearable Node Firmware
 * Target: Arduino Nano (ATmega328P)
 * 
 * Reads GPS (SoftwareSerial D3/D4), IMU (I2C A4/A5),
 * packages data into SensorPacket struct, transmits via
 * NRF24L01 (SPI, CE=D9, CSN=D10) every 500ms.
 *
 * CHANGE FOR NODE B: 
 *   - Set NODE_ID to 2
 *   - Set PIPE_ADDR to "EMBB2"
 *   - Add delay(250) at end of setup() for collision avoidance
 *
 * Libraries required:
 *   - RF24 by TMRh20
 *   - TinyGPSPlus
 *   - Wire (built-in)
 */

#include <SPI.h>
#include <RF24.h>
#include <TinyGPSPlus.h>
#include <SoftwareSerial.h>
#include <Wire.h>

// ── Configuration ──
#define NODE_ID       1            // 1 for Node A, 2 for Node B
#define PIPE_ADDR     "EMBA1"      // "EMBA1" for A, "EMBB2" for B
#define RF_CHANNEL    108
#define TX_INTERVAL   500          // ms between transmissions
#define BUZZER_PIN    6
#define GPS_RX_PIN    3            // Nano receives GPS data on D3
#define GPS_TX_PIN    4            // Nano sends to GPS on D4
#define NRF_CE_PIN    9
#define NRF_CSN_PIN   10
#define IMU_ADDR      0x68         // MPU6050 default (AD0=GND)

// ── Data packet (must match base station) ──
struct SensorPacket {
  uint8_t  nodeId;        // 1 byte
  float    latitude;      // 4 bytes
  float    longitude;     // 4 bytes
  float    heading;       // 4 bytes
  uint8_t  gpsFix;        // 1 byte
  uint8_t  alertFlag;     // 1 byte
  uint8_t  batteryPct;    // 1 byte
  uint16_t stationaryMs;  // 2 bytes
};                        // Total: 18 bytes

// ── Objects ──
RF24 radio(NRF_CE_PIN, NRF_CSN_PIN);
TinyGPSPlus gps;
SoftwareSerial gpsSerial(GPS_RX_PIN, GPS_TX_PIN);

// ── State ──
SensorPacket packet;
unsigned long lastTx = 0;
unsigned long lastMoveTime = 0;
float prevHeading = 0;

void setup() {
  Serial.begin(115200);  // Debug output
  Serial.println(F("EMBER Wearable Node starting..."));

  // Buzzer
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);
  delay(100);
  digitalWrite(BUZZER_PIN, LOW); // Startup beep

  // GPS
  gpsSerial.begin(9600);

  // IMU
  Wire.begin();
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x6B); // PWR_MGMT_1
  Wire.write(0x00); // Wake up
  Wire.endTransmission(true);

  // NRF24L01
  if (!radio.begin()) {
    Serial.println(F("NRF24L01 HARDWARE FAIL — check wiring"));
    while (1) { digitalWrite(BUZZER_PIN, HIGH); delay(200); digitalWrite(BUZZER_PIN, LOW); delay(200); }
  }

  radio.setChannel(RF_CHANNEL);
  radio.setDataRate(RF24_250KBPS);
  radio.setPALevel(RF24_PA_MAX);
  radio.setRetries(15, 15);
  radio.setPayloadSize(sizeof(SensorPacket));

  const byte addr[] = PIPE_ADDR;
  radio.openWritingPipe(addr);
  radio.stopListening();

  Serial.println(F("Radio OK. Transmitting..."));

  // Node B: uncomment this line for collision avoidance
  // delay(250);

  packet.nodeId = NODE_ID;
  lastMoveTime = millis();
}

void loop() {
  // ── Read GPS ──
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  if (gps.location.isValid()) {
    packet.latitude = gps.location.lat();
    packet.longitude = gps.location.lng();
    packet.gpsFix = 1;
  } else {
    packet.gpsFix = 0;
    // Keep last known lat/lng
  }

  // ── Read IMU heading ──
  packet.heading = readHeading();

  // ── Stationary detection ──
  // If heading changes significantly, reset timer
  if (abs(packet.heading - prevHeading) > 5.0) {
    lastMoveTime = millis();
    prevHeading = packet.heading;
  }
  packet.stationaryMs = (uint16_t)min((unsigned long)65535, millis() - lastMoveTime);

  // ── Alert flag ──
  // Auto-alert if stationary > 60 seconds
  packet.alertFlag = (packet.stationaryMs > 60000) ? 1 : 0;

  // ── Battery (placeholder — implement voltage divider on A0) ──
  packet.batteryPct = 100;

  // ── Transmit every TX_INTERVAL ms ──
  if (millis() - lastTx >= TX_INTERVAL) {
    lastTx = millis();

    bool ok = radio.write(&packet, sizeof(packet));
    if (ok) {
      Serial.print(F("TX OK "));
    } else {
      Serial.print(F("TX FAIL "));
    }
    Serial.print(packet.latitude, 6);
    Serial.print(F(","));
    Serial.print(packet.longitude, 6);
    Serial.print(F(" hdg="));
    Serial.println(packet.heading, 1);
  }

  // ── Buzzer alert when stationary too long ──
  if (packet.alertFlag) {
    digitalWrite(BUZZER_PIN, (millis() / 500) % 2 == 0 ? HIGH : LOW);
  } else {
    digitalWrite(BUZZER_PIN, LOW);
  }
}

/**
 * Read heading from MPU6050 gyroscope.
 * For a hackathon, simple gyro integration is sufficient.
 * If using MPU9250 or BNO055 with magnetometer, replace this
 * with compass heading for absolute bearing.
 */
float readHeading() {
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x47); // GYRO_ZOUT_H register
  Wire.endTransmission(false);
  Wire.requestFrom(IMU_ADDR, 2, true);

  int16_t gyroZ = Wire.read() << 8 | Wire.read();
  float angularVelocity = gyroZ / 131.0; // degrees per second (±250°/s range)

  // Integrate angular velocity (simple Euler integration)
  static float yaw = 0;
  static unsigned long lastTime = 0;
  unsigned long now = millis();
  float dt = (now - lastTime) / 1000.0;
  lastTime = now;

  if (dt > 0 && dt < 1.0) { // Sanity check
    yaw += angularVelocity * dt;
  }

  // Normalize to 0–360
  yaw = fmod(yaw, 360.0);
  if (yaw < 0) yaw += 360.0;

  return yaw;
}
