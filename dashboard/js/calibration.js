/* ════════════════════════════════════════════════════════════════
   EMBER Dashboard — calibration.js
   Two-point GPS-to-pixel calibration system.

   Flow:
     1. User clicks "Calibrate" button
     2. Clicks a point on the floor plan → records pixel coords
     3. Modal asks for GPS lat/lng → stores point 1
     4. Clicks a second point → records pixel coords
     5. Modal asks for GPS lat/lng → stores point 2
     6. System computes linear transform: GPS → pixel

   Public API:
     calibration          — state object with all calibration data
     startCalibration()   — begins the 2-point flow
     cancelCalibration()  — aborts
     submitCalPoint()     — called from modal confirm button
     gpsToPixel(lat, lng) — returns { x, y } canvas pixel or null
   ════════════════════════════════════════════════════════════════ */

const calibration = {
  done: false,
  step: 0,   // 0=idle, 1=waiting click 1, 2=got click waiting GPS 1, 3=waiting click 2, 4=got click waiting GPS 2
  pt1: { px: 0, py: 0, lat: 0, lng: 0 },
  pt2: { px: 0, py: 0, lat: 0, lng: 0 },
  // Computed transform
  pxPerDegLat: 0,
  pxPerDegLng: 0,
  refLat: 0,
  refLng: 0,
  refPx: 0,
  refPy: 0,
  // Floor plan image draw area on canvas
  imgX: 0,
  imgY: 0,
  imgW: 0,
  imgH: 0
};

/**
 * Begin calibration mode. Requires a floor plan to be loaded.
 */
function startCalibration() {
  if (!state.floorPlanLoaded) {
    addLog('Upload a floor plan first', 'warning');
    return;
  }
  calibration.done = false;
  calibration.step = 1;

  document.getElementById('calBanner').style.display = 'block';
  document.getElementById('calTitle').textContent = 'Calibration — Step 1 of 2';
  document.getElementById('calDesc').textContent = 'Click on a known reference point on the floor plan.';
  addLog('Calibration started — click a known point on the floor plan', 'info');
}

/**
 * Cancel calibration and reset state.
 */
function cancelCalibration() {
  calibration.step = 0;
  document.getElementById('calBanner').style.display = 'none';
  document.getElementById('calModal').classList.remove('open');
  addLog('Calibration cancelled', 'warning');
}

/**
 * Handle canvas click during calibration.
 * Called from the canvas click event listener in app.js.
 * @param {number} canvasX - click X in canvas coordinates
 * @param {number} canvasY - click Y in canvas coordinates
 * @returns {boolean} true if the click was consumed by calibration
 */
function handleCalibrationClick(canvasX, canvasY) {
  if (calibration.step !== 1 && calibration.step !== 3) return false;

  // Convert to floor-plan-image-relative coordinates
  const imgRelX = canvasX - calibration.imgX;
  const imgRelY = canvasY - calibration.imgY;

  // Reject clicks outside the image
  if (imgRelX < 0 || imgRelX > calibration.imgW || imgRelY < 0 || imgRelY > calibration.imgH) {
    return false;
  }

  if (calibration.step === 1) {
    calibration.pt1.px = imgRelX;
    calibration.pt1.py = imgRelY;
    calibration.step = 2;
    document.getElementById('calModalTitle').textContent = 'Calibration point 1';
    document.getElementById('calLat').value = '';
    document.getElementById('calLng').value = '';
    document.getElementById('calModal').classList.add('open');
  } else if (calibration.step === 3) {
    calibration.pt2.px = imgRelX;
    calibration.pt2.py = imgRelY;
    calibration.step = 4;
    document.getElementById('calModalTitle').textContent = 'Calibration point 2';
    document.getElementById('calLat').value = '';
    document.getElementById('calLng').value = '';
    document.getElementById('calModal').classList.add('open');
  }

  return true;
}

/**
 * Called when user confirms GPS coordinates in the modal.
 */
function submitCalPoint() {
  const lat = parseFloat(document.getElementById('calLat').value);
  const lng = parseFloat(document.getElementById('calLng').value);

  if (isNaN(lat) || isNaN(lng)) {
    addLog('Invalid coordinates — enter decimal numbers', 'danger');
    return;
  }

  if (calibration.step === 2) {
    // Save point 1, advance to waiting for click 2
    calibration.pt1.lat = lat;
    calibration.pt1.lng = lng;
    calibration.step = 3;
    document.getElementById('calModal').classList.remove('open');
    document.getElementById('calTitle').textContent = 'Calibration — Step 2 of 2';
    document.getElementById('calDesc').textContent = 'Now click on a second reference point (far from the first).';
    addLog(`Point 1 set: ${lat.toFixed(6)}, ${lng.toFixed(6)}`, 'info');

  } else if (calibration.step === 4) {
    // Save point 2, compute transform
    calibration.pt2.lat = lat;
    calibration.pt2.lng = lng;

    const dPxX = calibration.pt2.px - calibration.pt1.px;
    const dPxY = calibration.pt2.py - calibration.pt1.py;
    const dLat = calibration.pt2.lat - calibration.pt1.lat;
    const dLng = calibration.pt2.lng - calibration.pt1.lng;

    if (Math.abs(dLat) < 0.000001 && Math.abs(dLng) < 0.000001) {
      addLog('Points too close together — pick spots at least 20m apart', 'danger');
      calibration.step = 1;
      document.getElementById('calModal').classList.remove('open');
      return;
    }

    calibration.pxPerDegLat = Math.abs(dLat) > 0.000001 ? dPxY / dLat : 0;
    calibration.pxPerDegLng = Math.abs(dLng) > 0.000001 ? dPxX / dLng : 0;
    calibration.refLat = calibration.pt1.lat;
    calibration.refLng = calibration.pt1.lng;
    calibration.refPx = calibration.pt1.px;
    calibration.refPy = calibration.pt1.py;
    calibration.done = true;
    calibration.step = 0;

    document.getElementById('calModal').classList.remove('open');
    document.getElementById('calBanner').style.display = 'none';
    document.getElementById('mapInfo').style.display = 'block';
    document.getElementById('mapInfo').textContent = '✓ Calibrated';
    addLog(`Point 2 set: ${lat.toFixed(6)}, ${lng.toFixed(6)} — calibration complete`, 'success');
  }
}

/**
 * Convert GPS coordinates to canvas pixel position.
 * Returns { x, y } in absolute canvas coords, or null if not calibrated.
 */
function gpsToPixel(lat, lng) {
  if (!calibration.done) return null;

  const imgRelX = calibration.refPx + (lng - calibration.refLng) * calibration.pxPerDegLng;
  const imgRelY = calibration.refPy + (lat - calibration.refLat) * calibration.pxPerDegLat;

  return {
    x: imgRelX + calibration.imgX,
    y: imgRelY + calibration.imgY
  };
}

/**
 * Recompute floor plan image layout on canvas (called on resize or new image).
 */
function updateImageLayout(canvasW, canvasH, img) {
  const scale = Math.min(canvasW / img.width, canvasH / img.height) * 0.92;
  calibration.imgW = img.width * scale;
  calibration.imgH = img.height * scale;
  calibration.imgX = (canvasW - calibration.imgW) / 2;
  calibration.imgY = (canvasH - calibration.imgH) / 2;
}
