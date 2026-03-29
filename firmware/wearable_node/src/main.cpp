#include <SPI.h>
#include <RF24.h>
#include <TinyGPSPlus.h>
#include <SoftwareSerial.h>
#include <Wire.h>
#include <avr/wdt.h>

// Unique ID for this specific unit so the base station knows who is talking
#define NODE_ID      1
#define RF_CHANNEL   108
#define TX_INTERVAL  500
#define BUZZER_PIN   6
#define GPS_RX_PIN   3
#define GPS_TX_PIN   4
#define NRF_CE_PIN   9
#define NRF_CSN_PIN  10
#define IMU_ADDR     0x68

// Button pins
#define BTN_SURVIVOR   2   // "Survivor Here"
#define BTN_NO_SURVIVOR 5  // "No Survivor"
#define BTN_DANGER     7   // "Dangerous Area"

// Alert enums
#define ALERT_NONE        0
#define ALERT_STATIONARY  1  
#define ALERT_SURVIVOR    2   // survivor found here
#define ALERT_NO_SURVIVOR 3   // no survivor here
#define ALERT_DANGER      4   // dangerous area

const byte pipeAddr[] = "EMBB1";

//Base/Node struct
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
TinyGPSPlus gps;
SoftwareSerial gpsSerial(GPS_RX_PIN, GPS_TX_PIN);

SensorPacket packet;
unsigned long lastTx     = 0;
unsigned long lastMoveTime = 0;
float prevHeading        = 0;

//Dead reckoning state
float    drLat           = 0.0;   // current DR latitude
float    drLng           = 0.0;   // current DR longitude
bool     drInitialised   = false;
float    drSpeed         = 0.9;  
unsigned long lastDrUpdate = 0;

//Button debounce state
unsigned long lastBtnPress[3] = {0, 0, 0};
const uint8_t btnPins[3]      = {BTN_SURVIVOR, BTN_NO_SURVIVOR, BTN_DANGER};
const uint8_t btnAlerts[3]    = {ALERT_SURVIVOR, ALERT_NO_SURVIVOR, ALERT_DANGER};
const uint16_t DEBOUNCE_MS    = 300;

// Pending pin drop
bool    pendingPin     = false;
uint8_t pendingAlert   = ALERT_NONE;
float   pendingDrLat   = 0.0;
float   pendingDrLng   = 0.0;

float readHeading();
void  updateDeadReckoning();
void  checkButtons();
void  buzzerConfirm(uint8_t alertType);

void setup() {
  wdt_disable();
  Serial.begin(115200);
  Serial.println(F("Node A starting..."));

  // Button pins — internal pull-up, buttons connect pin to GND
  pinMode(BTN_SURVIVOR,    INPUT_PULLUP);
  pinMode(BTN_NO_SURVIVOR, INPUT_PULLUP);
  pinMode(BTN_DANGER,      INPUT_PULLUP);

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);
  delay(150);
  digitalWrite(BUZZER_PIN, LOW);

  gpsSerial.begin(9600);

  Wire.begin();
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);
  Wire.endTransmission(true);

  if (!radio.begin()) {
    Serial.println(F("NRF FAIL"));
    while (1) {
      digitalWrite(BUZZER_PIN, HIGH); delay(200);
      digitalWrite(BUZZER_PIN, LOW);  delay(200);
    }
  }

  radio.setChannel(RF_CHANNEL);
  radio.setDataRate(RF24_250KBPS);
  radio.setPALevel(RF24_PA_MAX);
  radio.setRetries(15, 15);
  radio.setPayloadSize(sizeof(SensorPacket));
  radio.openWritingPipe(pipeAddr);
  radio.stopListening();

  Serial.println(F("Node A ready."));
  packet.nodeId = NODE_ID;
  lastMoveTime  = millis();
  lastDrUpdate  = millis();
  wdt_enable(WDTO_2S);
}

void loop() {
  wdt_reset();

  // Feed GPS
  while (gpsSerial.available() > 0) gps.encode(gpsSerial.read());

  if (gps.location.isValid()) {
    packet.latitude  = gps.location.lat();
    packet.longitude = gps.location.lng();
    packet.gpsFix    = 1;
    // Use real GPS as DR anchor
    drLat          = packet.latitude;
    drLng          = packet.longitude;
    drInitialised  = true;
  } else {
    packet.latitude  = 0.0;
    packet.longitude = 0.0;
    packet.gpsFix    = 0;
  }

  packet.heading = readHeading();
  updateDeadReckoning();
  checkButtons();

  // Stationary detection
  if (abs(packet.heading - prevHeading) > 5.0) {
    lastMoveTime = millis();
    prevHeading  = packet.heading;
  }
  packet.stationaryMs = (uint16_t)min((unsigned long)65535, millis() - lastMoveTime);

  // Alert priority: button press overrides stationary alert
  if (pendingPin) {
    packet.alertFlag  = pendingAlert;
    packet.drLat      = pendingDrLat;
    packet.drLng      = pendingDrLng;
    packet.pinDrop    = 1;
  } else {
    packet.alertFlag  = (packet.stationaryMs > 60000) ? ALERT_STATIONARY : ALERT_NONE;
    packet.drLat      = drLat;
    packet.drLng      = drLng;
    packet.pinDrop    = 0;
  }

  packet.batteryPct = 100;

  if (millis() - lastTx >= TX_INTERVAL) {
    lastTx = millis();
    bool ok = radio.write(&packet, sizeof(packet));

    // If pin drop was sent, clear it
    if (pendingPin && ok) {
      pendingPin = false;
    }

    // Serial output as JSON for the  dashboard
    Serial.print(F("{\"id\":"));    Serial.print(packet.nodeId);
    Serial.print(F(",\"lat\":"));   Serial.print(packet.latitude, 6);
    Serial.print(F(",\"lng\":"));   Serial.print(packet.longitude, 6);
    Serial.print(F(",\"heading\":")); Serial.print(packet.heading, 1);
    Serial.print(F(",\"fix\":"));   Serial.print(packet.gpsFix);
    Serial.print(F(",\"alert\":")); Serial.print(packet.alertFlag);
    Serial.print(F(",\"batt\":"));  Serial.print(packet.batteryPct);
    Serial.print(F(",\"stat\":"));  Serial.print(packet.stationaryMs);
    Serial.print(F(",\"pin\":"));   Serial.print(packet.pinDrop);
    Serial.print(F(",\"drLat\":")); Serial.print(packet.drLat, 6);
    Serial.print(F(",\"drLng\":")); Serial.print(packet.drLng, 6);
    Serial.println(F("}"));
  }
}

//Dead reckoning update
// Converts heading + speed + elapsed time into a lat/lng offset
void updateDeadReckoning() {
  if (!drInitialised) return;

  unsigned long now = millis();
  float dt = (now - lastDrUpdate) / 1000.0;
  lastDrUpdate = now;

  if (dt <= 0 || dt > 2.0) return;

  // Only advance DR if unit is not stationary
  if (packet.stationaryMs > 3000) return;

  float distMetres = drSpeed * dt;

  // Convert heading to radians
  float headRad = packet.heading * PI / 180.0;

  // 1 degree latitude ≈ 111320 metres
  float dLat = (distMetres * cos(headRad)) / 111320.0;

  // 1 degree longitude ≈ 111320 * cos(lat) metres
  float cosLat = cos(drLat * PI / 180.0);
  float dLng = (cosLat > 0.001) ? (distMetres * sin(headRad)) / (111320.0 * cosLat) : 0.0;

  drLat += dLat;
  drLng += dLng;
}

//Button check with debounce
void checkButtons() {
  for (int i = 0; i < 3; i++) {
    // Buttons are INPUT_PULLUP so LOW = pressed
    if (digitalRead(btnPins[i]) == LOW) {
      unsigned long now = millis();
      if (now - lastBtnPress[i] > DEBOUNCE_MS) {
        lastBtnPress[i] = now;

        // Capture current DR position as pin drop location
        pendingPin     = true;
        pendingAlert   = btnAlerts[i];
        pendingDrLat   = drLat;
        pendingDrLng   = drLng;

         switch (btnAlerts[i]) {
          case ALERT_SURVIVOR:    Serial.println(F(">>> BUTTON: SURVIVOR HERE <<<")); break;
          case ALERT_NO_SURVIVOR: Serial.println(F(">>> BUTTON: NO SURVIVOR <<<")); break;
          case ALERT_DANGER:      Serial.println(F(">>> BUTTON: DANGEROUS AREA <<<")); break;
        }

        buzzerConfirm(btnAlerts[i]);

        Serial.print(F("BTN: alert="));
        Serial.print(btnAlerts[i]);
        Serial.print(F(" drLat="));
        Serial.print(drLat, 6);
        Serial.print(F(" drLng="));
        Serial.println(drLng, 6);
      }
    }
  }
}


void buzzerConfirm(uint8_t alertType) {
  wdt_reset();
  delay(10);  
  switch (alertType) {
    case ALERT_SURVIVOR:
      digitalWrite(BUZZER_PIN, HIGH); delay(80);
      digitalWrite(BUZZER_PIN, LOW);  delay(60);
      digitalWrite(BUZZER_PIN, HIGH); delay(80);
      digitalWrite(BUZZER_PIN, LOW);
      break;
    case ALERT_NO_SURVIVOR:
      digitalWrite(BUZZER_PIN, HIGH); delay(150);
      digitalWrite(BUZZER_PIN, LOW);
      break;
    case ALERT_DANGER:
      for (int i = 0; i < 3; i++) {
        digitalWrite(BUZZER_PIN, HIGH); delay(60);
        digitalWrite(BUZZER_PIN, LOW);  delay(50);
      }
      break;
  }
  wdt_reset();
}

float readHeading() {
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x47);
  Wire.endTransmission(false);
  Wire.requestFrom(IMU_ADDR, 2, true);
  int16_t gyroZ = Wire.read() << 8 | Wire.read();
  float rate = gyroZ / 131.0;

  static float yaw = 0;
  static unsigned long lastTime = 0;
  unsigned long now = millis();
  float dt = (now - lastTime) / 1000.0;
  lastTime = now;
  if (dt > 0 && dt < 1.0) yaw += rate * dt;
  yaw = fmod(yaw, 360.0);
  if (yaw < 0) yaw += 360.0;
  return yaw;
}
