/* ════════════════════════════════════════════════════════════════
   EMBER Dashboard — canvas.js
   Renders the floor plan image and firefighter markers on an
   HTML5 Canvas using requestAnimationFrame.

   Features:
     - Floor plan image with calibration point markers
     - Per-node colored circles (FF1=blue, FF2=amber)
     - Heading arrows showing direction of travel
     - Position trail (recent path)
     - Smooth position lerp (no teleporting)
     - Stale GPS pulsing (opacity oscillation)
     - Offline marker fade
     - Locate-node highlight ring
     - Alert flash indicator

   Public API:
     initCanvas()  — set up canvas, start render loop
     resizeCanvas() — recalculate dimensions (call on window resize)
   ════════════════════════════════════════════════════════════════ */

const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');

// Node visual config
const NODE_COLORS = {
  1: { fill: '#3b82f6', glow: 'rgba(59,130,246,0.3)' },
  2: { fill: '#f59e0b', glow: 'rgba(245,158,11,0.3)' }
};

const MARKER_RADIUS = 10;
const ARROW_LENGTH = 22;
const LERP_FACTOR = 0.15;  // smoothing speed (0 = no move, 1 = instant)
const TRAIL_MAX = 60;      // max trail points per node

/**
 * Resize canvas to fill its container.
 */
function resizeCanvas() {
  const container = document.getElementById('mapContainer');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;

  if (state.floorPlanLoaded) {
    updateImageLayout(canvas.width, canvas.height, state.floorPlan);
  }
}

/**
 * Initialize the canvas and start the animation loop.
 */
function initCanvas() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Canvas click handler for calibration
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;

    handleCalibrationClick(cx, cy);
  });

  requestAnimationFrame(renderFrame);
}

/**
 * Main render loop — called every frame via requestAnimationFrame.
 */
function renderFrame() {
  const now = Date.now();
  const { width: cw, height: ch } = canvas;
  ctx.clearRect(0, 0, cw, ch);

  // ── Draw floor plan ──
  if (state.floorPlanLoaded) {
    ctx.globalAlpha = 0.9;
    ctx.drawImage(state.floorPlan, calibration.imgX, calibration.imgY, calibration.imgW, calibration.imgH);
    ctx.globalAlpha = 1;

    // Draw calibration reference points
    if (calibration.done) {
      _drawCalPoint(calibration.pt1.px + calibration.imgX, calibration.pt1.py + calibration.imgY, '1');
      _drawCalPoint(calibration.pt2.px + calibration.imgX, calibration.pt2.py + calibration.imgY, '2');
    }
  }

  // ── Draw each firefighter node ──
  for (const id of [1, 2]) {
    const node = state.nodes[id];
    if (!node.lastSeen) continue;

    // Determine target pixel position
    let targetPos = null;

    if (calibration.done && node.lat !== 0) {
      targetPos = gpsToPixel(node.lat, node.lng);
    } else if (!calibration.done && node.lat !== 0 && state.floorPlanLoaded) {
      // Fallback: place proportionally in image area (pre-calibration dev mode)
      targetPos = {
        x: calibration.imgX + calibration.imgW * (0.3 + (id - 1) * 0.4),
        y: calibration.imgY + calibration.imgH * 0.5
      };
    }

    if (!targetPos) continue;

    // Smooth lerp to target
    if (node.displayX === null) {
      node.displayX = targetPos.x;
      node.displayY = targetPos.y;
    }
    node.displayX += (targetPos.x - node.displayX) * LERP_FACTOR;
    node.displayY += (targetPos.y - node.displayY) * LERP_FACTOR;

    const x = node.displayX;
    const y = node.displayY;
    const ago = now - node.lastSeen;
    const isStale = ago > 3000;
    const isOffline = ago > 10000;
    const colors = NODE_COLORS[id];

    // ── Trail ──
    if (calibration.done && node.trail.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = colors.fill;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      let started = false;
      for (let i = 0; i < node.trail.length; i++) {
        const tp = gpsToPixel(node.trail[i].lat, node.trail[i].lng);
        if (!tp) continue;
        const age = (now - node.trail[i].t) / 30000; // fade over 30s
        ctx.globalAlpha = Math.max(0.03, 0.2 - age * 0.2);
        if (!started) { ctx.moveTo(tp.x, tp.y); started = true; }
        else ctx.lineTo(tp.x, tp.y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ── Locate pulse ring ──
    if (state.locateTarget === id) {
      const pulseR = 30 + Math.sin(now * 0.005) * 15;
      ctx.beginPath();
      ctx.arc(x, y, pulseR, 0, Math.PI * 2);
      ctx.strokeStyle = colors.fill;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.4 + Math.sin(now * 0.005) * 0.3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ── Glow halo ──
    if (!isOffline) {
      ctx.beginPath();
      ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.fillStyle = colors.glow;
      ctx.globalAlpha = isStale ? 0.15 : 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ── Main circle ──
    ctx.beginPath();
    ctx.arc(x, y, MARKER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = colors.fill;
    if (isOffline) ctx.globalAlpha = 0.15;
    else if (isStale) ctx.globalAlpha = 0.3 + Math.sin(now * 0.003) * 0.2; // pulse
    else ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;

    // ── White border ring ──
    ctx.beginPath();
    ctx.arc(x, y, MARKER_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.globalAlpha = isOffline ? 0.1 : 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // ── Heading arrow ──
    if (!isOffline && node.heading !== undefined) {
      const angle = (node.heading - 90) * Math.PI / 180; // 0°=North=up
      const startR = MARKER_RADIUS + 2;
      const endR = ARROW_LENGTH;

      ctx.beginPath();
      ctx.moveTo(x + Math.cos(angle) * startR, y + Math.sin(angle) * startR);
      ctx.lineTo(x + Math.cos(angle) * endR, y + Math.sin(angle) * endR);
      ctx.strokeStyle = colors.fill;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Arrowhead
      const ax = x + Math.cos(angle) * endR;
      const ay = y + Math.sin(angle) * endR;
      const headLen = 6;
      const headAngle = 0.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - headLen * Math.cos(angle - headAngle), ay - headLen * Math.sin(angle - headAngle));
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - headLen * Math.cos(angle + headAngle), ay - headLen * Math.sin(angle + headAngle));
      ctx.strokeStyle = colors.fill;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // ── Label ──
    ctx.font = '600 11px "DM Sans", sans-serif';
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = isOffline ? 0.3 : 0.9;
    ctx.textAlign = 'center';
    ctx.fillText('FF' + id, x, y + 26);
    ctx.globalAlpha = 1;

    // ── Alert flash ──
    if (node.alert && !isOffline) {
      const flashOn = Math.floor(now / 400) % 2 === 0;
      if (flashOn) {
        ctx.beginPath();
        ctx.arc(x + 13, y - 13, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#e24b4a';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  requestAnimationFrame(renderFrame);
}

/**
 * Draw a small calibration reference marker.
 */
function _drawCalPoint(x, y, label) {
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(232,93,36,0.7)';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.font = '500 10px "DM Sans", sans-serif';
  ctx.fillStyle = '#e85d24';
  ctx.textAlign = 'center';
  ctx.fillText('P' + label, x, y - 10);
}
