/* ════════════════════════════════════════════════════════════════
   EMBER Dashboard — app.js
   Main application controller. Manages state, processes incoming
   packets, updates DOM elements, handles floor plan upload, and
   wires everything together on init.

   This file depends on:
     serial.js       — serialConnect/Disconnect/Write
     calibration.js  — calibration state, gpsToPixel, startCalibration
     canvas.js       — initCanvas, resizeCanvas
     mock.js         — toggleMock
   ════════════════════════════════════════════════════════════════ */

// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════
const state = {
  nodes: {
    1: { id:1, lat:0, lng:0, heading:0, fix:0, alert:0, batt:0, stat:0,
         lastSeen:0, displayX:null, displayY:null, trail:[] },
    2: { id:2, lat:0, lng:0, heading:0, fix:0, alert:0, batt:0, stat:0,
         lastSeen:0, displayX:null, displayY:null, trail:[] }
  },
  floorPlan: null,
  floorPlanLoaded: false,
  logs: [],
  locateTarget: null
};

// ═══════════════════════════════════════════════════════════════
//  ACTIVITY LOG
// ═══════════════════════════════════════════════════════════════

/**
 * Add a timestamped entry to the activity log.
 * @param {string} msg — log message text
 * @param {string} type — CSS class: 'info', 'success', 'warning', 'danger', or ''
 */
function addLog(msg, type = '') {
  const now = new Date();
  const time = now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

  state.logs.push({ time, msg, type });
  if (state.logs.length > 200) state.logs.shift();

  const scroll = document.getElementById('logScroll');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg ${type}">${_escapeHtml(msg)}</span>`;
  scroll.prepend(entry);

  // Keep DOM size bounded
  while (scroll.children.length > 100) scroll.removeChild(scroll.lastChild);
  document.getElementById('logCount').textContent = state.logs.length;
}

function _escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════════
//  PACKET PROCESSING
// ═══════════════════════════════════════════════════════════════

/**
 * Process an incoming SensorPacket (from serial or mock).
 * Updates state, triggers alerts, updates UI.
 */
function processPacket(p) {
  const id = p.id;
  if (id !== 1 && id !== 2) return;

  const node = state.nodes[id];
  const wasOffline = !node.lastSeen || (Date.now() - node.lastSeen) > 5000;

  // Update state
  node.lat = p.lat;
  node.lng = p.lng;
  node.heading = p.heading || 0;
  node.fix = p.fix !== undefined ? p.fix : 1;
  node.alert = p.alert || 0;
  node.batt = p.batt !== undefined ? p.batt : 100;
  node.stat = p.stat || 0;
  node.lastSeen = Date.now();

  // Append to trail
  if (node.fix && node.lat !== 0) {
    node.trail.push({ lat: node.lat, lng: node.lng, t: Date.now() });
    if (node.trail.length > 60) node.trail.shift();
  }

  // Log significant events
  if (wasOffline) addLog(`FF${id} connected`, 'success');
  if (node.alert) addLog(`FF${id} DISTRESS SIGNAL ACTIVE`, 'danger');
  if (node.stat > 60000) addLog(`FF${id} stationary > 60s — possible incapacitation`, 'warning');
  if (!node.fix && wasOffline === false) addLog(`FF${id} GPS fix lost`, 'warning');

  // Update card UI
  _updateNodeCard(id);

  // Alert styling on card
  const card = document.getElementById('card-' + id);
  if (node.alert) card.classList.add('alert-active');
  else card.classList.remove('alert-active');
}

// ═══════════════════════════════════════════════════════════════
//  NODE CARD UI
// ═══════════════════════════════════════════════════════════════
const COMPASS_DIRS = ['N','NE','E','SE','S','SW','W','NW'];

function _compassDir(deg) {
  return COMPASS_DIRS[Math.round(deg / 45) % 8];
}

function _timeSince(ts) {
  if (!ts) return '\u2014';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 2) return 'now';
  if (s < 60) return s + 's ago';
  return Math.floor(s / 60) + 'm ago';
}

function _updateNodeCard(id) {
  const n = state.nodes[id];
  const ago = Date.now() - n.lastSeen;
  const isOnline = ago < 3000;
  const isStale = ago >= 3000 && ago < 10000;

  // Status badge
  const statusEl = document.getElementById('status-' + id);
  if (isOnline) { statusEl.textContent = 'ONLINE'; statusEl.className = 'node-card-status online'; }
  else if (isStale) { statusEl.textContent = 'STALE'; statusEl.className = 'node-card-status stale'; }
  else { statusEl.textContent = 'OFFLINE'; statusEl.className = 'node-card-status offline'; }

  // Stat values
  const staleClass = n.fix ? '' : ' stale';
  _setText('lat-' + id, n.lat ? n.lat.toFixed(4) : '\u2014', staleClass);
  _setText('lng-' + id, n.lng ? n.lng.toFixed(4) : '\u2014', staleClass);
  _setText('heading-' + id, n.heading ? n.heading.toFixed(0) + '\u00B0 ' + _compassDir(n.heading) : '\u2014');
  _setText('fix-' + id, n.fix ? 'Locked' : 'No fix', n.fix ? '' : ' stale');
  _setText('lastUpdate-' + id, _timeSince(n.lastSeen));
  _setText('batt-' + id, n.batt + '%');

  // Battery bar
  const fill = document.getElementById('battFill-' + id);
  fill.style.width = n.batt + '%';
  fill.className = 'batt-fill' + (n.batt < 20 ? ' low' : n.batt < 50 ? ' mid' : '');
}

function _setText(elId, text, extraClass) {
  const el = document.getElementById(elId);
  el.textContent = text;
  el.className = 'node-stat-value' + (extraClass || '');
}

// Periodic "last seen" timer update
setInterval(() => { _updateNodeCard(1); _updateNodeCard(2); }, 1000);

// ═══════════════════════════════════════════════════════════════
//  ACTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Send a BUZZ alert command to a specific firefighter node.
 */
async function sendAlert(id) {
  const cmd = 'BUZZ:' + id + '\n';
  const sent = await serialWrite(cmd);
  if (sent) {
    addLog('Alert sent to FF' + id, 'info');
  } else {
    addLog('Alert sent to FF' + id + ' (no serial — mock mode)', 'info');
  }
}

/**
 * Highlight a node on the map for 3 seconds.
 */
function locateNode(id) {
  state.locateTarget = id;
  addLog('Locating FF' + id + ' on map', 'info');
  setTimeout(() => { state.locateTarget = null; }, 3000);
}

// ═══════════════════════════════════════════════════════════════
//  FLOOR PLAN UPLOAD
// ═══════════════════════════════════════════════════════════════

/**
 * Handle floor plan image file selection.
 */
function handleFloorPlan(event) {
  const file = event.target.files[0];
  if (!file) return;

  const img = new Image();
  img.onload = () => {
    state.floorPlan = img;
    state.floorPlanLoaded = true;
    document.getElementById('mapPlaceholder').style.display = 'none';
    document.getElementById('btnCalibrate').style.display = '';
    updateImageLayout(canvas.width, canvas.height, img);
    addLog('Floor plan loaded: ' + file.name + ' (' + img.width + '\u00D7' + img.height + ')', 'success');
  };
  img.src = URL.createObjectURL(file);
  event.target.value = '';
}

// ═══════════════════════════════════════════════════════════════
//  SERIAL EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════

/** Toggle connect/disconnect from top bar button */
async function handleConnect() {
  if (serial.connected) {
    await serialDisconnect();
  } else {
    if (mock.active) toggleMock(); // stop mock when connecting real hardware
    await serialConnect();
  }
}

// Listen for serial connection state changes
window.addEventListener('ember:serial', (e) => {
  const connected = e.detail.connected;
  document.getElementById('statusDot').className = connected ? 'status-dot connected' : 'status-dot';
  document.getElementById('statusLabel').textContent = connected ? 'Connected' : 'Disconnected';
  document.getElementById('btnConnect').textContent = connected ? 'Disconnect' : 'Connect';
  document.getElementById('btnConnect').className = connected ? 'btn btn-danger' : 'btn btn-primary';
});

// Listen for incoming packets from serial
window.addEventListener('ember:packet', (e) => {
  processPacket(e.detail);
});

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initCanvas();
  addLog('EMBER dashboard initialized', 'info');
  addLog('Upload a floor plan and connect to base station, or click Mock Data to test', '');
});
