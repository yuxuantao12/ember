/* ════════════════════════════════════════════════════════════════
   EMBER Dashboard — map.js
   Google Maps integration. Replaces the old canvas renderer and
   calibration system. GPS coordinates go directly onto the map
   with zero setup.

   Features:
     - Live Google Map centered on firefighter positions
     - Custom styled markers (FF1=blue, FF2=amber)
     - Heading arrows showing direction of travel
     - Position trail polylines (recent path history)
     - Stale/offline marker opacity changes
     - Alert pulse animation on markers
     - Auto-pan to keep all markers visible
     - Locate-node: zoom + bounce animation
     - Dark-themed map styling matching the dashboard

   Public API:
     initMap()          — called by Google Maps callback
     updateMapMarkers() — called from app.js after each packet
     locateNodeOnMap(id) — zoom to a specific node
   ════════════════════════════════════════════════════════════════ */

let map = null;
const markers = {};      // { 1: google.maps.Marker, 2: google.maps.Marker }
const headingMarkers = {};// heading direction indicators
const trails = {};       // { 1: google.maps.Polyline, 2: google.maps.Polyline }
const infoWindows = {};  // click-to-see-details popups
const drCircles = {};    // dead reckoning uncertainty circles
const statusOverlays = {};// status message toast overlays
let hasInitialFix = false;
let StatusToastOverlay = null; // Defined after google maps loads

// Status code display config — matches firmware alertFlag values
// 0=null, 1=stationary (handled separately), 2=survivor, 3=no_survivor, 4=danger
const STATUS_CONFIG = {
  0: null,
  1: null, // stationary — already handled by stationary detection, no toast
  2: { text: 'SURVIVOR FOUND', bg: '#2ecc71', color: '#fff', icon: '✓' },
  3: { text: 'NO SURVIVOR', bg: '#e67e22', color: '#fff', icon: '✗' },
  4: { text: 'DANGEROUS AREA', bg: '#e24b4a', color: '#fff', icon: '⚠' }
};

// ── Dark map style matching the EMBER dashboard theme ──
const MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1a1e2a" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0d0f12" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#6b6a66" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#2c2c2c" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a2e3a" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a1e28" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3a3e4a" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1118" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#1e222e" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1a2418" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#1e222e" }] },
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
];

// ── Marker icon SVGs ──
function createMarkerIcon(color, isStale, isOffline, isDR) {
  const opacity = isOffline ? 0.3 : isStale ? 0.5 : 1.0;
  const drRing = isDR && !isOffline ? `<circle cx="18" cy="18" r="16" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="4,3" stroke-opacity="${opacity * 0.7}"/>` : '';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="16" fill="${color}" fill-opacity="${opacity * 0.25}" stroke="${color}" stroke-width="${isDR ? '0' : '2'}" stroke-opacity="${opacity}"/>
      ${drRing}
      <circle cx="18" cy="18" r="8" fill="${color}" fill-opacity="${opacity}" stroke="white" stroke-width="2" stroke-opacity="${opacity * 0.8}"/>
      ${isDR ? `<text x="18" y="22" text-anchor="middle" font-size="9" font-weight="bold" fill="white" opacity="${opacity}">DR</text>` : ''}
    </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(36, 36),
    anchor: new google.maps.Point(18, 18)
  };
}

function createHeadingIcon(color, heading) {
  const rad = (heading - 90) * Math.PI / 180;
  const tipX = 18 + Math.cos(rad) * 16;
  const tipY = 18 + Math.sin(rad) * 16;
  const baseX = 18 + Math.cos(rad) * 6;
  const baseY = 18 + Math.sin(rad) * 6;
  const leftX = 18 + Math.cos(rad - 2.6) * 10;
  const leftY = 18 + Math.sin(rad - 2.6) * 10;
  const rightX = 18 + Math.cos(rad + 2.6) * 10;
  const rightY = 18 + Math.sin(rad + 2.6) * 10;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
      <line x1="${baseX}" y1="${baseY}" x2="${tipX}" y2="${tipY}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
      <polygon points="${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}" fill="${color}" opacity="0.9"/>
    </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(36, 36),
    anchor: new google.maps.Point(18, 18)
  };
}

const NODE_COLORS = {
  1: '#3b82f6',
  2: '#f59e0b'
};

const TRAIL_COLORS = {
  1: '#3b82f6',
  2: '#f59e0b'
};

/**
 * Initialize Google Map. Called by the Maps API callback.
 */
function initMap() {
  _defineDraggableFloorPlan(); // Define the class now that google.maps is available
  _defineStatusToastOverlay(); // Define status toast overlay class

  const defaultCenter = { lat: 29.6516, lng: -82.3248 }; // Gainesville, FL

  map = new google.maps.Map(document.getElementById('map'), {
    center: defaultCenter,
    zoom: 18,
    styles: MAP_STYLE,
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: true,
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.DROPDOWN_MENU,
      position: google.maps.ControlPosition.TOP_RIGHT
    },
    streetViewControl: false,
    fullscreenControl: true,
    gestureHandling: 'greedy',
    mapTypeId: 'roadmap'
  });

  // Initialize markers and trails for both nodes
  for (const id of [1, 2]) {
    const color = NODE_COLORS[id];

    markers[id] = new google.maps.Marker({
      map: null, // hidden until data arrives
      icon: createMarkerIcon(color, false, false),
      title: 'Firefighter ' + id,
      zIndex: 10
    });

    headingMarkers[id] = new google.maps.Marker({
      map: null,
      icon: createHeadingIcon(color, 0),
      zIndex: 9,
      clickable: false
    });

    trails[id] = new google.maps.Polyline({
      map: map,
      path: [],
      strokeColor: color,
      strokeOpacity: 0.4,
      strokeWeight: 3
    });

    infoWindows[id] = new google.maps.InfoWindow();

    markers[id].addListener('click', () => {
      const n = state.nodes[id];
      const ago = n.lastSeen ? Math.floor((Date.now() - n.lastSeen) / 1000) : '—';
      const posSource = n.fix ? '<span style="color:#2ecc71">GPS</span>' : '<span style="color:#f39c12">Dead Reckoning</span>';
      infoWindows[id].setContent(`
        <div style="font-family:sans-serif;font-size:13px;color:#333;min-width:160px">
          <strong style="color:${color}">Firefighter ${id}</strong><br>
          <span style="color:#666">Position:</span> ${posSource}<br>
          <span style="color:#666">Lat:</span> ${n.lat ? n.lat.toFixed(6) : '—'}<br>
          <span style="color:#666">Lng:</span> ${n.lng ? n.lng.toFixed(6) : '—'}<br>
          <span style="color:#666">Heading:</span> ${n.heading ? n.heading.toFixed(0) + '°' : '—'}<br>
          <span style="color:#666">Battery:</span> ${n.batt}%<br>
          <span style="color:#666">Last seen:</span> ${ago}s ago
        </div>
      `);
      infoWindows[id].open(map, markers[id]);
    });
  }

  addLog('Google Map initialized', 'success');

  // Start periodic marker update
  setInterval(updateMapMarkers, 500);
}

/**
 * Update all map markers based on current state.
 * Called periodically and after each packet.
 */
function updateMapMarkers() {
  if (!map) return;

  const now = Date.now();
  const bounds = new google.maps.LatLngBounds();
  let hasAnyMarker = false;

  for (const id of [1, 2]) {
    const node = state.nodes[id];
    if (!node.lastSeen || node.lat === 0) {
      markers[id].setMap(null);
      headingMarkers[id].setMap(null);
      continue;
    }

    const pos = new google.maps.LatLng(node.lat, node.lng);
    const ago = now - node.lastSeen;
    const isStale = ago > 3000;
    const isOffline = ago > 10000;
    const isDR = !node.fix && node.lat !== 0; // Dead reckoning active
    const color = NODE_COLORS[id];

    // Update marker position and icon
    markers[id].setPosition(pos);
    markers[id].setIcon(createMarkerIcon(color, isStale, isOffline, isDR));
    markers[id].setMap(map);

    // Update heading arrow
    if (node.heading !== undefined && !isOffline) {
      headingMarkers[id].setPosition(pos);
      headingMarkers[id].setIcon(createHeadingIcon(color, node.heading));
      headingMarkers[id].setMap(map);
    } else {
      headingMarkers[id].setMap(null);
    }

    // Dead reckoning radius circle (shows uncertainty)
    if (!drCircles[id]) {
      drCircles[id] = new google.maps.Circle({
        map: null,
        strokeColor: color,
        strokeOpacity: 0.4,
        strokeWeight: 1,
        fillColor: color,
        fillOpacity: 0.06,
        center: pos,
        radius: 5
      });
    }
    if (isDR && !isOffline) {
      // Uncertainty grows over time — radius expands from 5m at start to ~30m after 60s
      const drDuration = node._drStartTime ? (now - node._drStartTime) / 1000 : 0;
      const uncertaintyRadius = Math.min(30, 5 + drDuration * 0.4);
      drCircles[id].setCenter(pos);
      drCircles[id].setRadius(uncertaintyRadius);
      drCircles[id].setMap(map);
    } else {
      drCircles[id].setMap(null);
      if (!isDR) node._drStartTime = 0;
    }

    // Track when DR started
    if (isDR && !node._drStartTime) {
      node._drStartTime = now;
    }

    // Update trail
    if (node.trail.length > 0) {
      const trailPath = node.trail
        .filter(p => p.lat !== 0)
        .map(p => new google.maps.LatLng(p.lat, p.lng));
      trails[id].setPath(trailPath);
      trails[id].setOptions({
        strokeOpacity: isOffline ? 0.15 : isStale ? 0.25 : 0.4,
        strokeColor: isDR ? color : color,
        strokeWeight: isDR ? 2 : 3,
        // Dashed line for dead-reckoned trail segments
        icons: isDR ? [{
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.6, scale: 3 },
          offset: '0', repeat: '12px'
        }] : []
      });
    }

    bounds.extend(pos);
    hasAnyMarker = true;
  }

  // Auto-center map on first valid fix
  if (hasAnyMarker && !hasInitialFix) {
    hasInitialFix = true;
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      // Only one point — just center on it
      map.setCenter(bounds.getCenter());
      map.setZoom(18);
    } else {
      map.fitBounds(bounds, { padding: 80 });
    }
    addLog('Map centered on firefighter positions', 'info');
  }
}

/**
 * Zoom and bounce to a specific node on the map.
 */
function locateNodeOnMap(id) {
  const node = state.nodes[id];
  if (!node.lastSeen || node.lat === 0) {
    addLog('FF' + id + ' has no position data', 'warning');
    return;
  }

  const pos = new google.maps.LatLng(node.lat, node.lng);
  map.panTo(pos);
  map.setZoom(19);

  // Bounce animation
  if (markers[id]) {
    markers[id].setAnimation(google.maps.Animation.BOUNCE);
    setTimeout(() => markers[id].setAnimation(null), 2000);
  }

  addLog('Locating FF' + id + ' on map', 'info');
}

// ═══════════════════════════════════════════════════════════════
//  FLOOR PLAN OVERLAY — Draggable, Resizable, Rotatable
//  Uses a custom OverlayView so the floor plan image can be
//  clicked and dragged directly on the map, resized from corners,
//  and rotated with a handle. Firefighter markers always render
//  on top of the overlay.
// ═══════════════════════════════════════════════════════════════

let floorOverlay = null;
let overlayImageUrl = null;
let DraggableFloorPlan = null; // Defined after Google Maps loads

// Overlay state
const overlayState = {
  centerLat: 0,
  centerLng: 0,
  spreadLat: 0,
  spreadLng: 0,
  rotation: 0,
  opacity: 0.85,
  locked: false,
  dragging: false,
  resizing: false,
  dragStartLat: 0,
  dragStartLng: 0,
  dragStartCenterLat: 0,
  dragStartCenterLng: 0,
  resizeCorner: null,
  resizeStartLat: 0,
  resizeStartLng: 0,
  resizeStartSpreadLat: 0,
  resizeStartSpreadLng: 0
};

/**
 * Called once from initMap() after google.maps is available.
 * Defines the DraggableFloorPlan class.
 */
function _defineDraggableFloorPlan() {
  DraggableFloorPlan = class extends google.maps.OverlayView {
  constructor(imageUrl) {
    super();
    this.imageUrl = imageUrl;
    this.div = null;
    this.img = null;
    this.handles = [];
  }

  onAdd() {
    this.div = document.createElement('div');
    this.div.style.cssText = 'position:absolute;cursor:move;';
    this.div.id = 'floorPlanDiv';

    this.img = document.createElement('img');
    this.img.src = this.imageUrl;
    this.img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;';
    this.img.draggable = false;
    this.div.appendChild(this.img);

    // Corner resize handles
    const corners = ['nw','ne','sw','se'];
    corners.forEach(corner => {
      const handle = document.createElement('div');
      handle.className = 'overlay-handle overlay-handle-' + corner;
      handle.dataset.corner = corner;
      handle.style.cssText = `
        position:absolute;width:14px;height:14px;background:#e85d24;
        border:2px solid #fff;border-radius:3px;cursor:nwse-resize;z-index:2;
        box-shadow:0 0 6px rgba(0,0,0,0.5);
      `;
      if (corner.includes('n')) handle.style.top = '-7px'; else handle.style.bottom = '-7px';
      if (corner.includes('w')) handle.style.left = '-7px'; else handle.style.right = '-7px';
      if (corner === 'ne' || corner === 'sw') handle.style.cursor = 'nesw-resize';
      this.div.appendChild(handle);
      this.handles.push(handle);

      // Resize drag events
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (overlayState.locked) return;
        overlayState.resizing = true;
        overlayState.resizeCorner = corner;
        overlayState.resizeStartSpreadLat = overlayState.spreadLat;
        overlayState.resizeStartSpreadLng = overlayState.spreadLng;

        const proj = this.getProjection();
        const point = new google.maps.Point(e.clientX, e.clientY);
        // Store starting mouse position
        overlayState._resizeMouseStartX = e.clientX;
        overlayState._resizeMouseStartY = e.clientY;

        const moveHandler = (ev) => {
          if (!overlayState.resizing) return;
          const dx = ev.clientX - overlayState._resizeMouseStartX;
          const dy = ev.clientY - overlayState._resizeMouseStartY;

          // Scale factor based on mouse movement
          const scaleFactor = 1 + (dx + dy) * 0.002;
          const clampedScale = Math.max(0.1, Math.min(5, scaleFactor));

          overlayState.spreadLat = overlayState.resizeStartSpreadLat * clampedScale;
          overlayState.spreadLng = overlayState.resizeStartSpreadLng * clampedScale;
          this.draw();
        };

        const upHandler = () => {
          overlayState.resizing = false;
          document.removeEventListener('mousemove', moveHandler);
          document.removeEventListener('mouseup', upHandler);
        };

        document.addEventListener('mousemove', moveHandler);
        document.addEventListener('mouseup', upHandler);
      });
    });

    // Rotation handle
    const rotHandle = document.createElement('div');
    rotHandle.style.cssText = `
      position:absolute;top:-30px;left:50%;transform:translateX(-50%);
      width:12px;height:12px;background:#f0763e;border:2px solid #fff;
      border-radius:50%;cursor:grab;z-index:2;
      box-shadow:0 0 6px rgba(0,0,0,0.5);
    `;
    // Rotation line
    const rotLine = document.createElement('div');
    rotLine.style.cssText = `
      position:absolute;top:-20px;left:50%;transform:translateX(-50%);
      width:1px;height:20px;background:rgba(255,255,255,0.4);
    `;
    this.div.appendChild(rotLine);
    this.div.appendChild(rotHandle);

    rotHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (overlayState.locked) return;

      const rect = this.div.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const moveHandler = (ev) => {
        const angle = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
        overlayState.rotation = ((angle % 360) + 360) % 360;
        this.draw();
      };

      const upHandler = () => {
        document.removeEventListener('mousemove', moveHandler);
        document.removeEventListener('mouseup', upHandler);
      };

      document.addEventListener('mousemove', moveHandler);
      document.addEventListener('mouseup', upHandler);
    });

    // Main div drag-to-move
    this.div.addEventListener('mousedown', (e) => {
      if (overlayState.locked || overlayState.resizing) return;
      if (e.target !== this.div && e.target !== this.img) return;

      overlayState.dragging = true;
      map.set('draggable', false);

      const proj = this.getProjection();
      const startLatLng = proj.fromContainerPixelToLatLng(new google.maps.Point(e.clientX, e.clientY));
      overlayState.dragStartLat = startLatLng.lat();
      overlayState.dragStartLng = startLatLng.lng();
      overlayState.dragStartCenterLat = overlayState.centerLat;
      overlayState.dragStartCenterLng = overlayState.centerLng;
      this.div.style.cursor = 'grabbing';

      const moveHandler = (ev) => {
        if (!overlayState.dragging) return;
        const currentLatLng = proj.fromContainerPixelToLatLng(new google.maps.Point(ev.clientX, ev.clientY));
        const dLat = currentLatLng.lat() - overlayState.dragStartLat;
        const dLng = currentLatLng.lng() - overlayState.dragStartLng;
        overlayState.centerLat = overlayState.dragStartCenterLat + dLat;
        overlayState.centerLng = overlayState.dragStartCenterLng + dLng;
        this.draw();
      };

      const upHandler = () => {
        overlayState.dragging = false;
        map.set('draggable', true);
        this.div.style.cursor = 'move';
        document.removeEventListener('mousemove', moveHandler);
        document.removeEventListener('mouseup', upHandler);
      };

      document.addEventListener('mousemove', moveHandler);
      document.addEventListener('mouseup', upHandler);
    });

    // Border to show it's interactive
    this.div.style.border = '2px dashed rgba(232,93,36,0.5)';
    this.div.style.borderRadius = '4px';

    const panes = this.getPanes();
    panes.overlayMouseTarget.appendChild(this.div);
  }

  draw() {
    const proj = this.getProjection();
    if (!proj) return;

    const sw = proj.fromLatLngToDivPixel(new google.maps.LatLng(
      overlayState.centerLat - overlayState.spreadLat,
      overlayState.centerLng - overlayState.spreadLng
    ));
    const ne = proj.fromLatLngToDivPixel(new google.maps.LatLng(
      overlayState.centerLat + overlayState.spreadLat,
      overlayState.centerLng + overlayState.spreadLng
    ));

    const w = Math.abs(ne.x - sw.x);
    const h = Math.abs(sw.y - ne.y);

    this.div.style.left = Math.min(sw.x, ne.x) + 'px';
    this.div.style.top = Math.min(sw.y, ne.y) + 'px';
    this.div.style.width = w + 'px';
    this.div.style.height = h + 'px';
    this.div.style.opacity = overlayState.opacity;
    this.div.style.transform = 'rotate(' + overlayState.rotation + 'deg)';

    // Show/hide handles based on lock state
    const handleDisplay = overlayState.locked ? 'none' : 'block';
    this.div.querySelectorAll('.overlay-handle, div[style*="border-radius:50%"], div[style*="width:1px"]').forEach(el => {
      el.style.display = handleDisplay;
    });
    this.div.style.border = overlayState.locked ? 'none' : '2px dashed rgba(232,93,36,0.5)';
    this.div.style.cursor = overlayState.locked ? 'default' : 'move';
  }

  onRemove() {
    if (this.div) {
      this.div.parentNode.removeChild(this.div);
      this.div = null;
    }
  }
  }; // end of DraggableFloorPlan class
} // end of _defineDraggableFloorPlan()

/**
 * Define StatusToastOverlay class. Called from initMap().
 * Shows a floating message bubble near a firefighter marker on the map.
 */
function _defineStatusToastOverlay() {
  StatusToastOverlay = class extends google.maps.OverlayView {
    constructor(position, nodeId, config) {
      super();
      this.position = position;
      this.nodeId = nodeId;
      this.config = config;
      this.div = null;
    }

    onAdd() {
      this.div = document.createElement('div');
      const ffColor = this.nodeId === 1 ? '#3b82f6' : '#f59e0b';
      this.div.style.cssText = `
        position:absolute;
        background:${this.config.bg};
        color:${this.config.color};
        padding:8px 14px;
        border-radius:8px;
        font-family:'DM Sans',sans-serif;
        font-size:12px;
        font-weight:600;
        letter-spacing:0.5px;
        white-space:nowrap;
        box-shadow:0 4px 20px rgba(0,0,0,0.5);
        pointer-events:none;
        transform:translateX(-50%) translateY(-100%);
        margin-top:-20px;
        animation:toastAppear 0.4s ease;
        z-index:100;
      `;
      this.div.innerHTML = `
        <span style="margin-right:6px;font-size:14px">${this.config.icon}</span>
        <span style="border-left:1px solid rgba(255,255,255,0.3);padding-left:8px;margin-left:2px">FF${this.nodeId}: ${this.config.text}</span>
      `;

      // Add tail/arrow pointing down
      const tail = document.createElement('div');
      tail.style.cssText = `
        position:absolute;
        bottom:-6px;
        left:50%;
        transform:translateX(-50%);
        width:0;height:0;
        border-left:6px solid transparent;
        border-right:6px solid transparent;
        border-top:6px solid ${this.config.bg};
      `;
      this.div.appendChild(tail);

      // Inject animation keyframes if not already present
      if (!document.getElementById('toastAnimStyle')) {
        const style = document.createElement('style');
        style.id = 'toastAnimStyle';
        style.textContent = `
          @keyframes toastAppear {
            from { opacity:0; transform:translateX(-50%) translateY(-100%) scale(0.8); }
            to { opacity:1; transform:translateX(-50%) translateY(-100%) scale(1); }
          }
          @keyframes toastFade {
            from { opacity:1; }
            to { opacity:0; transform:translateX(-50%) translateY(-100%) scale(0.9); }
          }
        `;
        document.head.appendChild(style);
      }

      this.getPanes().floatPane.appendChild(this.div);
    }

    draw() {
      if (!this.div) return;
      const proj = this.getProjection();
      if (!proj) return;
      const point = proj.fromLatLngToDivPixel(this.position);
      this.div.style.left = point.x + 'px';
      this.div.style.top = point.y + 'px';
    }

    dismiss() {
      if (this.div) {
        this.div.style.animation = 'toastFade 0.3s ease forwards';
        setTimeout(() => this.setMap(null), 300);
      }
    }

    onRemove() {
      if (this.div && this.div.parentNode) {
        this.div.parentNode.removeChild(this.div);
        this.div = null;
      }
    }
  };
}

/**
 * Show a status toast on the map for a firefighter.
 * Removes any existing toast for that node first.
 * Toast auto-dismisses after 8 seconds.
 */
function showStatusToast(nodeId, statusCode) {
  if (!map || !StatusToastOverlay) return;

  const config = STATUS_CONFIG[statusCode];
  if (!config) {
    // Status cleared — remove existing toast
    if (statusOverlays[nodeId]) {
      statusOverlays[nodeId].dismiss();
      statusOverlays[nodeId] = null;
    }
    return;
  }

  const node = state.nodes[nodeId];
  if (!node || node.lat === 0) return;

  // Remove existing toast for this node
  if (statusOverlays[nodeId]) {
    statusOverlays[nodeId].setMap(null);
    statusOverlays[nodeId] = null;
  }

  const pos = new google.maps.LatLng(node.lat, node.lng);
  const toast = new StatusToastOverlay(pos, nodeId, config);
  toast.setMap(map);
  statusOverlays[nodeId] = toast;

  // Auto-dismiss after 8 seconds
  setTimeout(() => {
    if (statusOverlays[nodeId] === toast) {
      toast.dismiss();
      statusOverlays[nodeId] = null;
    }
  }, 8000);
}

/**
 * Handle floor plan image upload.
 */
function handleFloorPlanUpload(event) {
  const file = event.target.files[0];
  if (!file || !map) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    overlayImageUrl = e.target.result;

    const img = new Image();
    img.onload = function() {
      const aspectRatio = img.width / img.height;
      const center = map.getCenter();
      const zoom = map.getZoom();
      const spread = 0.0008 * Math.pow(2, 18 - zoom);

      overlayState.centerLat = center.lat();
      overlayState.centerLng = center.lng();
      overlayState.spreadLat = spread;
      overlayState.spreadLng = spread * aspectRatio;
      overlayState.rotation = 0;
      overlayState.opacity = 0.85;
      overlayState.locked = false;

      // Remove existing overlay
      if (floorOverlay) {
        floorOverlay.setMap(null);
      }

      floorOverlay = new DraggableFloorPlan(overlayImageUrl);
      floorOverlay.setMap(map);

      document.getElementById('btnRemoveOverlay').style.display = '';
      document.getElementById('btnFloorPlan').textContent = 'Replace Floor Plan';

      addOverlayControls();

      addLog('Floor plan loaded: ' + file.name + ' — drag to position, corners to resize, top handle to rotate', 'success');
    };
    img.src = overlayImageUrl;
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

/**
 * Overlay control panel — opacity, rotation reset, lock toggle.
 */
function addOverlayControls() {
  const existing = document.getElementById('overlayControls');
  if (existing) existing.remove();

  const controlDiv = document.createElement('div');
  controlDiv.id = 'overlayControls';
  controlDiv.style.cssText = `
    position:absolute;bottom:20px;left:20px;z-index:5;
    background:rgba(13,15,18,0.92);backdrop-filter:blur(8px);
    border-radius:10px;border:1px solid rgba(255,255,255,0.06);
    padding:12px 14px;display:flex;flex-direction:column;gap:8px;
    font-family:'DM Sans',sans-serif;font-size:11px;color:#9b9a95;
  `;

  const btnStyle = `padding:5px 10px;border:1px solid rgba(255,255,255,0.06);border-radius:4px;
    background:rgba(255,255,255,0.04);color:#e8e6e1;cursor:pointer;font-size:11px;font-family:inherit;`;

  controlDiv.innerHTML = `
    <div style="font-size:12px;font-weight:600;color:#e85d24;margin-bottom:2px">Floor Plan Controls</div>
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="min-width:55px">Opacity</span>
      <input type="range" min="10" max="100" value="85" style="flex:1;width:100px;accent-color:#e85d24;"
        oninput="overlayState.opacity=this.value/100;if(floorOverlay)floorOverlay.draw()">
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="min-width:55px">Rotation</span>
      <input type="range" min="0" max="360" value="0" id="rotationSlider" style="flex:1;width:100px;accent-color:#e85d24;"
        oninput="overlayState.rotation=parseInt(this.value);if(floorOverlay)floorOverlay.draw()">
      <span id="rotationLabel" style="min-width:30px;font-family:monospace">0\u00B0</span>
    </div>
    <div style="display:flex;gap:6px;margin-top:2px;">
      <button style="${btnStyle}" onclick="toggleOverlayLock()" id="btnLockOverlay">Lock Position</button>
      <button style="${btnStyle}" onclick="overlayState.rotation=0;document.getElementById('rotationSlider').value=0;if(floorOverlay)floorOverlay.draw()">Reset Rotation</button>
    </div>
    <div style="font-size:10px;color:#6b6a66;margin-top:2px;line-height:1.4">
      Drag floor plan to move \u2022 Drag corners to resize<br>
      Drag top circle to rotate \u2022 Lock when aligned
    </div>
  `;

  // Update rotation label on slider input
  const slider = controlDiv.querySelector('#rotationSlider');
  slider.addEventListener('input', () => {
    controlDiv.querySelector('#rotationLabel').textContent = slider.value + '\u00B0';
  });

  document.getElementById('mapContainer').appendChild(controlDiv);
}

/**
 * Toggle lock state — when locked, overlay can't be moved/resized.
 */
function toggleOverlayLock() {
  overlayState.locked = !overlayState.locked;
  const btn = document.getElementById('btnLockOverlay');
  if (overlayState.locked) {
    btn.textContent = 'Unlock Position';
    btn.style.background = 'rgba(232,93,36,0.15)';
    btn.style.color = '#e85d24';
    addLog('Floor plan locked in place', 'info');
  } else {
    btn.textContent = 'Lock Position';
    btn.style.background = 'rgba(255,255,255,0.04)';
    btn.style.color = '#e8e6e1';
    addLog('Floor plan unlocked — drag to reposition', 'info');
  }
  if (floorOverlay) floorOverlay.draw();
}

/**
 * Remove the floor plan overlay.
 */
function removeFloorPlanOverlay() {
  if (floorOverlay) {
    floorOverlay.setMap(null);
    floorOverlay = null;
    overlayImageUrl = null;
  }

  const controls = document.getElementById('overlayControls');
  if (controls) controls.remove();

  document.getElementById('btnRemoveOverlay').style.display = 'none';
  document.getElementById('btnFloorPlan').textContent = 'Upload Floor Plan';

  addLog('Floor plan overlay removed', 'info');
}