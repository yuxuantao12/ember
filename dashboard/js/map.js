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
let hasInitialFix = false;

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
function createMarkerIcon(color, isStale, isOffline) {
  const opacity = isOffline ? 0.3 : isStale ? 0.5 : 1.0;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="16" fill="${color}" fill-opacity="${opacity * 0.25}" stroke="${color}" stroke-width="2" stroke-opacity="${opacity}"/>
      <circle cx="18" cy="18" r="8" fill="${color}" fill-opacity="${opacity}" stroke="white" stroke-width="2" stroke-opacity="${opacity * 0.8}"/>
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
      infoWindows[id].setContent(`
        <div style="font-family:sans-serif;font-size:13px;color:#333;min-width:160px">
          <strong style="color:${color}">Firefighter ${id}</strong><br>
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
    const color = NODE_COLORS[id];

    // Update marker position and icon
    markers[id].setPosition(pos);
    markers[id].setIcon(createMarkerIcon(color, isStale, isOffline));
    markers[id].setMap(map);

    // Update heading arrow
    if (node.heading !== undefined && !isOffline) {
      headingMarkers[id].setPosition(pos);
      headingMarkers[id].setIcon(createHeadingIcon(color, node.heading));
      headingMarkers[id].setMap(map);
    } else {
      headingMarkers[id].setMap(null);
    }

    // Update trail
    if (node.trail.length > 0) {
      const trailPath = node.trail
        .filter(p => p.lat !== 0)
        .map(p => new google.maps.LatLng(p.lat, p.lng));
      trails[id].setPath(trailPath);
      trails[id].setOptions({
        strokeOpacity: isOffline ? 0.15 : isStale ? 0.25 : 0.4
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
