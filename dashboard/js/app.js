/* ════════════════════════════════════════════════════════════════
   EMBER Dashboard — app.js
   Main application controller. Manages state, processes incoming
   packets, updates DOM elements, and wires everything together.

   Dependencies (load order in index.html):
     1. serial.js    — Web Serial API
     2. map.js       — Google Maps rendering
     3. mock.js      — Fake data generator
     4. app.js       — This file (last)
   ════════════════════════════════════════════════════════════════ */

// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════
const state = {
  nodes: {
    1: { id:1, lat:0, lng:0, heading:0, fix:0, alert:0, batt:0, stat:0,
         lastSeen:0, trail:[] },
    2: { id:2, lat:0, lng:0, heading:0, fix:0, alert:0, batt:0, stat:0,
         lastSeen:0, trail:[] }
  },
  logs: []
};

// ═══════════════════════════════════════════════════════════════
//  ACTIVITY LOG
// ═══════════════════════════════════════════════════════════════
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
function processPacket(p) {
  const id = p.id;
  if (id !== 1 && id !== 2) return;

  const node = state.nodes[id];
  const wasOffline = !node.lastSeen || (Date.now() - node.lastSeen) > 5000;

  node.lat = p.lat;
  node.lng = p.lng;
  node.heading = p.heading || 0;
  node.fix = p.fix !== undefined ? p.fix : 1;
  node.alert = p.alert || 0;
  node.batt = p.batt !== undefined ? p.batt : 100;
  node.stat = p.stat || 0;
  node.lastSeen = Date.now();

  if (node.fix && node.lat !== 0) {
    node.trail.push({ lat: node.lat, lng: node.lng, t: Date.now() });
    if (node.trail.length > 120) node.trail.shift();
  }

  if (wasOffline) addLog(`FF${id} connected`, 'success');
  if (node.alert) addLog(`FF${id} DISTRESS SIGNAL ACTIVE`, 'danger');
  if (node.stat > 60000) addLog(`FF${id} stationary > 60s`, 'warning');
  if (!node.fix && !wasOffline) addLog(`FF${id} GPS fix lost`, 'warning');

  _updateNodeCard(id);

  const card = document.getElementById('card-' + id);
  if (node.alert) card.classList.add('alert-active');
  else card.classList.remove('alert-active');

  updateMapMarkers();
}

// ═══════════════════════════════════════════════════════════════
//  NODE CARD UI
// ═══════════════════════════════════════════════════════════════
const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];

function _updateNodeCard(id) {
  const n = state.nodes[id];
  const ago = Date.now() - n.lastSeen;
  const isOnline = ago < 3000;
  const isStale = ago >= 3000 && ago < 10000;

  const s = document.getElementById('status-' + id);
  if (isOnline) { s.textContent = 'ONLINE'; s.className = 'node-card-status online'; }
  else if (isStale) { s.textContent = 'STALE'; s.className = 'node-card-status stale'; }
  else { s.textContent = 'OFFLINE'; s.className = 'node-card-status offline'; }

  const sc = n.fix ? '' : ' stale';
  _set('lat-'+id, n.lat ? n.lat.toFixed(6) : '\u2014', sc);
  _set('lng-'+id, n.lng ? n.lng.toFixed(6) : '\u2014', sc);
  _set('heading-'+id, n.heading ? n.heading.toFixed(0)+'\u00B0 '+COMPASS[Math.round(n.heading/45)%8] : '\u2014');
  _set('fix-'+id, n.fix ? 'Locked' : 'No fix', n.fix ? '' : ' stale');

  const secs = n.lastSeen ? Math.floor((Date.now()-n.lastSeen)/1000) : null;
  _set('lastUpdate-'+id, secs===null ? '\u2014' : secs<2 ? 'now' : secs<60 ? secs+'s ago' : Math.floor(secs/60)+'m ago');
  _set('batt-'+id, n.batt+'%');

  const f = document.getElementById('battFill-'+id);
  f.style.width = n.batt+'%';
  f.className = 'batt-fill'+(n.batt<20?' low':n.batt<50?' mid':'');
}

function _set(elId, text, cls) {
  const el = document.getElementById(elId);
  el.textContent = text;
  el.className = 'node-stat-value'+(cls||'');
}

setInterval(() => { _updateNodeCard(1); _updateNodeCard(2); }, 1000);

// ═══════════════════════════════════════════════════════════════
//  ACTIONS
// ═══════════════════════════════════════════════════════════════
async function sendAlert(id) {
  const cmd = 'BUZZ:'+id+'\n';
  const sent = await serialWrite(cmd);
  addLog('Alert sent to FF'+id+(sent?'':' (mock mode)'), 'info');
}

function locateNode(id) { locateNodeOnMap(id); }

async function handleConnect() {
  if (serial.connected) { await serialDisconnect(); }
  else { if (mock.active) toggleMock(); await serialConnect(); }
}

window.addEventListener('ember:serial', (e) => {
  const c = e.detail.connected;
  document.getElementById('statusDot').className = c ? 'status-dot connected' : 'status-dot';
  document.getElementById('statusLabel').textContent = c ? 'Connected' : 'Disconnected';
  document.getElementById('btnConnect').textContent = c ? 'Disconnect' : 'Connect';
  document.getElementById('btnConnect').className = c ? 'btn btn-danger' : 'btn btn-primary';
});

window.addEventListener('ember:packet', (e) => { processPacket(e.detail); });

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
addLog('EMBER dashboard initialized', 'info');
addLog('Click Connect for hardware, or Mock Data to simulate', '');
