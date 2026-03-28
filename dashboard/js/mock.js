/* ════════════════════════════════════════════════════════════════
   EMBER Dashboard — mock.js
   Generates simulated SensorPacket data so the CS person can
   develop the entire UI without any hardware connected.

   FF1 walks in a slow circle, FF2 walks a figure-8 pattern.
   Occasional GPS dropouts and depleting batteries are simulated.

   Public API:
     toggleMock()  — start/stop the mock generator
     mock.active   — boolean, whether mock is running
   ════════════════════════════════════════════════════════════════ */

const mock = {
  active: false,
  interval: null,
  t: 0
};

// Base coordinates (Gainesville, FL area — adjust to your demo location)
const MOCK_BASE_LAT = 29.6516;
const MOCK_BASE_LNG = -82.3248;

/**
 * Toggle the mock data generator on/off.
 */
function toggleMock() {
  mock.active = !mock.active;
  const btn = document.getElementById('btnMock');

  if (mock.active) {
    // Stop real serial if connected
    if (serial.connected) {
      addLog('Disconnecting serial — mock mode takes over', 'warning');
      serialDisconnect();
    }

    btn.textContent = 'Stop Mock';
    btn.className = 'btn btn-danger';
    addLog('Mock data generator started — 2 simulated firefighters', 'info');
    mock.interval = setInterval(_generateFrame, 500);
  } else {
    btn.textContent = 'Mock Data';
    btn.className = 'btn';
    addLog('Mock data generator stopped', 'info');
    clearInterval(mock.interval);
    mock.interval = null;
  }
}

/**
 * Generate one frame of mock data (called every 500ms).
 */
function _generateFrame() {
  mock.t += 0.02;
  const t = mock.t;

  // ── FF1: slow circle ──
  const r1 = 0.0003;
  const lat1 = MOCK_BASE_LAT + Math.sin(t) * r1;
  const lng1 = MOCK_BASE_LNG + Math.cos(t) * r1;
  const heading1 = ((Math.atan2(Math.cos(t), Math.sin(t)) * 180 / Math.PI) + 360) % 360;

  processPacket({
    id: 1,
    lat: lat1,
    lng: lng1,
    heading: heading1,
    fix: 1,
    alert: 0,
    batt: Math.max(10, 87 - Math.floor(t * 0.2)),
    stat: 0
  });

  // ── FF2: figure-8 pattern ──
  const r2 = 0.0002;
  const lat2 = MOCK_BASE_LAT + 0.0004 + Math.sin(t * 1.3) * r2;
  const lng2 = MOCK_BASE_LNG + 0.0002 + Math.sin(t * 0.65) * r2 * 2;
  const heading2 = ((Math.atan2(Math.cos(t * 1.3), Math.sin(t * 0.65) * 2) * 180 / Math.PI) + 360) % 360;

  processPacket({
    id: 2,
    lat: lat2,
    lng: lng2,
    heading: heading2,
    fix: Math.random() > 0.05 ? 1 : 0,  // 5% chance of GPS dropout
    alert: 0,
    batt: Math.max(15, 92 - Math.floor(t * 0.15)),
    stat: 0
  });
}
