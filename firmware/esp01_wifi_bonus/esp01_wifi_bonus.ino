/*
 * EMBER — ESP-01 WiFi Dashboard (BONUS FEATURE)
 * Target: ESP-01 (ESP8266, Generic ESP8266 Module in Arduino IDE)
 *
 * Creates a WiFi access point "EMBER-DASH" and serves a simple
 * status page at http://192.168.4.1 showing firefighter data.
 * Receives JSON lines from the base station Nano via Serial (RX pin).
 *
 * WIRING:
 *   ESP-01 RX  ← Nano D3 via voltage divider (1K + 2K)
 *   ESP-01 VCC → Nano 3.3V
 *   ESP-01 GND → Nano GND
 *   CH_PD, GPIO0, RST → 3.3V via 10K pullup each
 *
 * FLASHING:
 *   Board: "Generic ESP8266 Module"
 *   Flash Size: 1M (no SPIFFS)
 *   Upload Speed: 115200
 *   GPIO0 must be LOW during flash, HIGH during run.
 *
 * Libraries required:
 *   - ESP8266WiFi (built-in with ESP8266 board package)
 *   - ESP8266WebServer (built-in)
 */

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>

// ── Configuration ──
const char* AP_SSID = "EMBER-DASH";
const char* AP_PASS = "";  // Open network (or set a password for judges)

ESP8266WebServer server(80);

// ── Latest data for each firefighter ──
struct NodeData {
  float lat;
  float lng;
  float heading;
  uint8_t fix;
  uint8_t alert;
  uint8_t batt;
  uint16_t stat;
  unsigned long lastUpdate;
  bool hasData;
};

NodeData nodes[3]; // index 0 unused, 1 = FF1, 2 = FF2

void setup() {
  Serial.begin(115200); // Receives JSON from Nano D3

  // Initialize node data
  for (int i = 0; i < 3; i++) {
    nodes[i].hasData = false;
    nodes[i].lastUpdate = 0;
  }

  // Start WiFi access point
  WiFi.softAP(AP_SSID, AP_PASS);
  IPAddress ip = WiFi.softAPIP();

  // Register web server routes
  server.on("/", handleRoot);
  server.on("/data", handleData);
  server.begin();
}

void loop() {
  // ── Read JSON lines from Nano ──
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.startsWith("{")) {
      parseJson(line);
    }
  }

  // ── Handle web requests ──
  server.handleClient();
}

/**
 * Parse a JSON line and update node data.
 * Simple manual parsing to avoid ArduinoJson dependency.
 */
void parseJson(String &json) {
  int id = extractInt(json, "\"id\":");
  if (id != 1 && id != 2) return;

  nodes[id].lat = extractFloat(json, "\"lat\":");
  nodes[id].lng = extractFloat(json, "\"lng\":");
  nodes[id].heading = extractFloat(json, "\"heading\":");
  nodes[id].fix = extractInt(json, "\"fix\":");
  nodes[id].alert = extractInt(json, "\"alert\":");
  nodes[id].batt = extractInt(json, "\"batt\":");
  nodes[id].stat = extractInt(json, "\"stat\":");
  nodes[id].lastUpdate = millis();
  nodes[id].hasData = true;
}

int extractInt(String &json, const char* key) {
  int idx = json.indexOf(key);
  if (idx < 0) return 0;
  idx += strlen(key);
  return json.substring(idx).toInt();
}

float extractFloat(String &json, const char* key) {
  int idx = json.indexOf(key);
  if (idx < 0) return 0;
  idx += strlen(key);
  return json.substring(idx).toFloat();
}

/**
 * Serve the main dashboard HTML page.
 * Auto-refreshes every 2 seconds.
 */
void handleRoot() {
  String html = "<!DOCTYPE html><html><head>";
  html += "<meta charset='UTF-8'>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<meta http-equiv='refresh' content='2'>";
  html += "<title>EMBER</title>";
  html += "<style>";
  html += "body{font-family:sans-serif;background:#0d0f12;color:#e8e6e1;padding:16px;margin:0}";
  html += "h1{color:#e85d24;font-size:24px;margin-bottom:4px}";
  html += "h2{color:#9b9a95;font-size:12px;font-weight:400;margin-bottom:16px}";
  html += ".card{background:#181c28;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:14px;margin-bottom:12px}";
  html += ".card h3{font-size:14px;margin-bottom:8px}";
  html += ".ff1 h3{color:#3b82f6} .ff2 h3{color:#f59e0b}";
  html += ".row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px}";
  html += ".label{color:#6b6a66} .value{font-family:monospace}";
  html += ".online{color:#2ecc71} .offline{color:#e24b4a} .stale{color:#f39c12}";
  html += ".alert{color:#e24b4a;font-weight:700;text-align:center;padding:8px;background:rgba(226,75,74,0.12);border-radius:8px;margin-top:8px}";
  html += "</style></head><body>";

  html += "<h1>EMBER</h1>";
  html += "<h2>Firefighter Tracking &mdash; WiFi Dashboard</h2>";

  for (int id = 1; id <= 2; id++) {
    html += "<div class='card ff" + String(id) + "'>";
    html += "<h3>Firefighter " + String(id) + " &mdash; ";

    if (!nodes[id].hasData) {
      html += "<span class='offline'>NO DATA</span>";
    } else {
      unsigned long ago = (millis() - nodes[id].lastUpdate) / 1000;
      if (ago < 3) html += "<span class='online'>ONLINE</span>";
      else if (ago < 10) html += "<span class='stale'>STALE (" + String(ago) + "s)</span>";
      else html += "<span class='offline'>OFFLINE (" + String(ago) + "s)</span>";
    }
    html += "</h3>";

    if (nodes[id].hasData) {
      html += "<div class='row'><span class='label'>Position</span><span class='value'>";
      html += String(nodes[id].lat, 4) + ", " + String(nodes[id].lng, 4);
      html += "</span></div>";
      html += "<div class='row'><span class='label'>Heading</span><span class='value'>";
      html += String(nodes[id].heading, 0) + "&deg;</span></div>";
      html += "<div class='row'><span class='label'>GPS Fix</span><span class='value'>";
      html += nodes[id].fix ? "Locked" : "<span class='stale'>No fix</span>";
      html += "</span></div>";
      html += "<div class='row'><span class='label'>Battery</span><span class='value'>";
      html += String(nodes[id].batt) + "%</span></div>";

      if (nodes[id].alert) {
        html += "<div class='alert'>⚠ DISTRESS SIGNAL ACTIVE</div>";
      }
    }

    html += "</div>";
  }

  html += "<p style='color:#6b6a66;font-size:11px;text-align:center;margin-top:16px'>";
  html += "Auto-refreshes every 2s &bull; Connected clients: " + String(WiFi.softAPgetStationNum());
  html += "</p></body></html>";

  server.send(200, "text/html", html);
}

/**
 * JSON API endpoint for programmatic access.
 */
void handleData() {
  String json = "{\"nodes\":[";
  for (int id = 1; id <= 2; id++) {
    if (id > 1) json += ",";
    json += "{\"id\":" + String(id);
    json += ",\"lat\":" + String(nodes[id].lat, 6);
    json += ",\"lng\":" + String(nodes[id].lng, 6);
    json += ",\"heading\":" + String(nodes[id].heading, 1);
    json += ",\"fix\":" + String(nodes[id].fix);
    json += ",\"alert\":" + String(nodes[id].alert);
    json += ",\"batt\":" + String(nodes[id].batt);
    json += ",\"ago\":" + String(nodes[id].hasData ? (millis() - nodes[id].lastUpdate) / 1000 : -1);
    json += "}";
  }
  json += "]}";
  server.send(200, "application/json", json);
}
