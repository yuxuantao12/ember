#include <Arduino.h>
/*
 * EMBER — Wearable Node Firmware (with Dead Reckoning)
 * Target: Arduino Nano (ATmega328P)
 * 
 * When GPS has fix: sends GPS coordinates.
 * When GPS is lost indoors: uses dead reckoning —
 *   MPU9250 magnetometer for compass heading +
 *   accelerometer step detection + estimated stride length
 *   to calculate position from the last known GPS fix.
 *
 * CHANGE FOR NODE B: 
 *   - Set NODE_ID to 2
 *   - Set PIPE_ADDR to "EMBB2"
 *   - Uncomment delay(250) in setup()
 *
 * Libraries: RF24 (TMRh20), TinyGPSPlus, Wire
 */

#include <SPI.h>
#include <RF24.h>
#include <TinyGPSPlus.h>
#include <SoftwareSerial.h>
#include <Wire.h>

// ── Configuration ──
#define NODE_ID       1
#define PIPE_ADDR     "EMBA1"
#define RF_CHANNEL    108
#define TX_INTERVAL   500          // ms between transmissions
#define BUZZER_PIN    6
#define GPS_RX_PIN    3
#define GPS_TX_PIN    4
#define NRF_CE_PIN    9
#define NRF_CSN_PIN   10
#define IMU_ADDR      0x68         // MPU9250 accel/gyro address (AD0=GND)
#define MAG_ADDR      0x0C         // AK8963 magnetometer inside MPU9250

// ── Dead reckoning config ──
#define STRIDE_LENGTH_M     0.7    // Average stride length in meters
#define STEP_THRESHOLD      1.3    // Acceleration magnitude threshold for step (g)
#define STEP_COOLDOWN_MS    300    // Min time between steps (prevents double-count)
#define DEG_PER_METER_LAT   0.000008983  // ~1 meter in degrees latitude
#define DEG_PER_METER_LNG   0.000010365  // ~1 meter in degrees longitude (at ~29N)
#define GPS_STALE_TIMEOUT_MS 5000  // If GPS coords don't change for 5s, switch to DR

// ── Data packet (must match base station) ──
struct SensorPacket {
  uint8_t  nodeId;        // 1 byte
  float    latitude;      // 4 bytes
  float    longitude;     // 4 bytes
  float    heading;       // 4 bytes — compass heading 0-360
  uint8_t  gpsFix;        // 1 byte — 1=GPS, 0=dead reckoning
  uint8_t  alertFlag;     // 1 byte
  uint8_t  batteryPct;    // 1 byte
  uint16_t stationaryMs;  // 2 bytes
};                        // Total: 18 bytes

// ── Forward declarations ──
float readCompassHeading();
bool detectStep();
void updateDeadReckoning();
void initMPU9250();
void initMagnetometer();
float readAccelMagnitude();

// ── Objects ──
RF24 radio(NRF_CE_PIN, NRF_CSN_PIN);
TinyGPSPlus gps;
SoftwareSerial gpsSerial(GPS_RX_PIN, GPS_TX_PIN);

// ── State ──
SensorPacket packet;
unsigned long lastTx = 0;
unsigned long lastMoveTime = 0;
unsigned long lastStepTime = 0;

// Dead reckoning state
float drLat = 0;
float drLng = 0;
float lastGpsLat = 0;
float lastGpsLng = 0;
bool hadGpsFix = false;
unsigned long gpsLostTime = 0;
unsigned long lastGpsUpdateTime = 0;  // Last time GPS coords actually changed
uint16_t stepCount = 0;

// Step detection state
float prevAccelMag = 1.0;
bool wasAboveThreshold = false;

// Magnetometer calibration offsets (hard-iron)
// To calibrate: rotate sensor in all directions, record min/max per axis
// offset = (max + min) / 2
float magOffsetX = 0;
float magOffsetY = 0;

void setup() {
  Serial.begin(115200);
  Serial.println(F("EMBER Wearable (Dead Reckoning) starting..."));

  // Buzzer startup beep
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);
  delay(100);
  digitalWrite(BUZZER_PIN, LOW);

  // GPS
  gpsSerial.begin(9600);

  // MPU9250 + Magnetometer
  Wire.begin();
  initMPU9250();
  initMagnetometer();

  // NRF24L01
  if (!radio.begin()) {
    Serial.println(F("NRF24L01 HARDWARE FAIL"));
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

  // Node B: uncomment for collision avoidance
  // delay(250);

  packet.nodeId = NODE_ID;
  lastMoveTime = millis();
}

void loop() {
  // ── Read GPS ──
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  // ── Read compass heading (always) ──
  packet.heading = readCompassHeading();

  // ── Determine position source ──
  // GPS modules keep reporting last fix as "valid" even indoors.
  // We detect stale GPS by checking if coordinates actually change.
  bool gpsHasFreshFix = false;

  if (gps.location.isValid()) {
    float newLat = gps.location.lat();
    float newLng = gps.location.lng();

    // Did the coordinates actually change? (moved > ~1 meter)
    float dLat = abs(newLat - lastGpsLat);
    float dLng = abs(newLng - lastGpsLng);
    bool moved = (dLat > 0.000009 || dLng > 0.000010);

    if (moved) {
      // Genuinely new GPS position — we are outdoors
      lastGpsUpdateTime = millis();
      gpsHasFreshFix = true;
    } else if (millis() - lastGpsUpdateTime < GPS_STALE_TIMEOUT_MS) {
      // Not moved but was outdoors recently — could just be standing still
      gpsHasFreshFix = true;
    }
    // else: GPS valid but hasn't moved in 5s — stale, switch to DR
  }

  if (gpsHasFreshFix) {
    // GPS working — use GPS coordinates
    packet.latitude = gps.location.lat();
    packet.longitude = gps.location.lng();
    packet.gpsFix = 1;

    lastGpsLat = packet.latitude;
    lastGpsLng = packet.longitude;
    drLat = packet.latitude;
    drLng = packet.longitude;
    hadGpsFix = true;
    stepCount = 0;
    gpsLostTime = 0;

  } else if (hadGpsFix) {
    // GPS stale or lost — dead reckoning from last known position
    packet.gpsFix = 0;

    if (gpsLostTime == 0) {
      gpsLostTime = millis();
      Serial.println(F("GPS stale — dead reckoning active"));
    }

    // Detect steps and update estimated position
    if (detectStep()) {
      updateDeadReckoning();
      stepCount++;
    }

    packet.latitude = drLat;
    packet.longitude = drLng;

  } else {
    // Never had GPS — send zeros
    packet.gpsFix = 0;
    packet.latitude = 0;
    packet.longitude = 0;
  }

  // ── Stationary detection via accelerometer ──
  float accelMag = readAccelMagnitude();
  if (abs(accelMag - 1.0) > 0.15) {
    lastMoveTime = millis();
  }
  packet.stationaryMs = (uint16_t)min((unsigned long)65535, millis() - lastMoveTime);

  // ── Alert ──
  packet.alertFlag = (packet.stationaryMs > 60000) ? 1 : 0;

  // ── Battery ──
  packet.batteryPct = 100;

  // ── Transmit ──
  if (millis() - lastTx >= TX_INTERVAL) {
    lastTx = millis();
    bool ok = radio.write(&packet, sizeof(packet));

    Serial.print(ok ? F("TX OK ") : F("TX FAIL "));
    Serial.print(packet.gpsFix ? F("GPS ") : F("DR  "));
    Serial.print(packet.latitude, 6);
    Serial.print(F(","));
    Serial.print(packet.longitude, 6);
    Serial.print(F(" hdg="));
    Serial.print(packet.heading, 1);
    if (!packet.gpsFix && hadGpsFix) {
      Serial.print(F(" steps="));
      Serial.print(stepCount);
    }
    Serial.println();
  }

  // ── Buzzer ──
  if (packet.alertFlag) {
    digitalWrite(BUZZER_PIN, (millis() / 500) % 2 == 0 ? HIGH : LOW);
  } else {
    digitalWrite(BUZZER_PIN, LOW);
  }
}

// ═══════════════════════════════════════════════════════════════
//  MPU9250 INIT
// ═══════════════════════════════════════════════════════════════

void initMPU9250() {
  // Wake up
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);
  Wire.endTransmission(true);
  delay(100);

  // Accelerometer ±2g
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x1C);
  Wire.write(0x00);
  Wire.endTransmission(true);

  // Gyro ±250 deg/s
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x1B);
  Wire.write(0x00);
  Wire.endTransmission(true);

  // Enable I2C bypass for magnetometer access
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x37);
  Wire.write(0x02);
  Wire.endTransmission(true);
  delay(10);

  Serial.println(F("MPU9250 accel/gyro OK"));
}

void initMagnetometer() {
  // AK8963: continuous mode 2 (100Hz), 16-bit
  Wire.beginTransmission(MAG_ADDR);
  Wire.write(0x0A);
  Wire.write(0x16);
  Wire.endTransmission(true);
  delay(10);

  // Verify
  Wire.beginTransmission(MAG_ADDR);
  Wire.write(0x00);
  Wire.endTransmission(false);
  Wire.requestFrom(MAG_ADDR, 1);
  uint8_t id = Wire.read();

  if (id == 0x48) {
    Serial.println(F("AK8963 magnetometer OK"));
  } else {
    Serial.print(F("Magnetometer ID: 0x"));
    Serial.println(id, HEX);
    Serial.println(F("Warning: unexpected ID — compass may not work"));
  }
}

// ═══════════════════════════════════════════════════════════════
//  COMPASS HEADING
// ═══════════════════════════════════════════════════════════════

float readCompassHeading() {
  Wire.beginTransmission(MAG_ADDR);
  Wire.write(0x03);
  Wire.endTransmission(false);
  Wire.requestFrom(MAG_ADDR, 7); // 6 data + ST2 (must read ST2)

  if (Wire.available() < 7) return 0;

  int16_t mx = Wire.read() | (Wire.read() << 8);
  int16_t my = Wire.read() | (Wire.read() << 8);
  int16_t mz = Wire.read() | (Wire.read() << 8);
  Wire.read(); // ST2

  float fx = (float)mx - magOffsetX;
  float fy = (float)my - magOffsetY;

  float heading = atan2(fy, fx) * 180.0 / PI;
  if (heading < 0) heading += 360.0;

  return heading;
}

// ═══════════════════════════════════════════════════════════════
//  ACCELEROMETER
// ═══════════════════════════════════════════════════════════════

float readAccelMagnitude() {
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x3B);
  Wire.endTransmission(false);
  Wire.requestFrom(IMU_ADDR, 6, true);

  int16_t ax = (Wire.read() << 8) | Wire.read();
  int16_t ay = (Wire.read() << 8) | Wire.read();
  int16_t az = (Wire.read() << 8) | Wire.read();

  float gx = ax / 16384.0;
  float gy = ay / 16384.0;
  float gz = az / 16384.0;

  return sqrt(gx * gx + gy * gy + gz * gz);
}

// ═══════════════════════════════════════════════════════════════
//  STEP DETECTION
//  Peak detection on accelerometer magnitude.
//  A step creates a spike above STEP_THRESHOLD.
//  Detected on the falling edge with cooldown.
// ═══════════════════════════════════════════════════════════════

bool detectStep() {
  float mag = readAccelMagnitude();
  bool isAbove = (mag > STEP_THRESHOLD);
  bool stepDetected = false;

  // Falling edge: was above, now below
  if (wasAboveThreshold && !isAbove) {
    unsigned long now = millis();
    if (now - lastStepTime > STEP_COOLDOWN_MS) {
      stepDetected = true;
      lastStepTime = now;
      lastMoveTime = now;
    }
  }

  wasAboveThreshold = isAbove;
  prevAccelMag = mag;
  return stepDetected;
}

// ═══════════════════════════════════════════════════════════════
//  DEAD RECKONING
//  Each step moves position by STRIDE_LENGTH in compass heading.
// ═══════════════════════════════════════════════════════════════

void updateDeadReckoning() {
  float headingRad = packet.heading * PI / 180.0;

  // Displacement in meters
  float dNorth = STRIDE_LENGTH_M * cos(headingRad);
  float dEast  = STRIDE_LENGTH_M * sin(headingRad);

  // Convert to degrees
  drLat += dNorth * DEG_PER_METER_LAT;
  drLng += dEast  * DEG_PER_METER_LNG;
}