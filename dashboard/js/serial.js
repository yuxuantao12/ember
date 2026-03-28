/* ════════════════════════════════════════════════════════════════
   EMBER Dashboard — serial.js
   Web Serial API layer: connects to the Arduino Nano base station,
   reads JSON lines, exposes write() for sending commands back.

   Public API:
     serialConnect()    — opens port picker, connects, starts reading
     serialDisconnect() — closes port cleanly
     serialWrite(str)   — sends a string to the Nano (e.g. "BUZZ:1\n")
     serial.connected   — boolean, current connection state
   
   Events (dispatched on window):
     'ember:packet'     — detail: parsed JSON object from Nano
     'ember:serial'     — detail: { connected: bool }
   ════════════════════════════════════════════════════════════════ */

const serial = {
  port: null,
  reader: null,
  writer: null,
  connected: false,
  _inputDone: null,
  _outputDone: null
};

/**
 * Request a serial port, open it, and begin reading JSON lines.
 * Dispatches 'ember:serial' with { connected: true } on success.
 */
async function serialConnect() {
  if (serial.connected) return;

  if (!('serial' in navigator)) {
    addLog('Web Serial API not supported — use Chrome or Edge', 'danger');
    return;
  }

  try {
    serial.port = await navigator.serial.requestPort();
    await serial.port.open({ baudRate: 115200 });
    serial.connected = true;

    // Set up writer for sending commands back to the Nano
    const encoder = new TextEncoderStream();
    serial._outputDone = encoder.readable.pipeTo(serial.port.writable);
    serial.writer = encoder.writable.getWriter();

    window.dispatchEvent(new CustomEvent('ember:serial', { detail: { connected: true } }));
    addLog('Serial port connected at 115200 baud', 'success');

    // Begin read loop
    _readLoop();

  } catch (err) {
    addLog('Connection failed: ' + err.message, 'danger');
  }
}

/**
 * Internal: continuously reads from the serial port, buffers bytes
 * into newline-terminated strings, parses each as JSON, and dispatches
 * 'ember:packet' events.
 */
async function _readLoop() {
  const decoder = new TextDecoderStream();
  serial._inputDone = serial.port.readable.pipeTo(decoder.writable);
  serial.reader = decoder.readable.getReader();

  let buffer = '';

  try {
    while (true) {
      const { value, done } = await serial.reader.read();
      if (done) break;

      buffer += value;

      // Split on newlines — the Nano sends one JSON line per packet
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep the incomplete tail

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const packet = JSON.parse(trimmed);
          window.dispatchEvent(new CustomEvent('ember:packet', { detail: packet }));
        } catch {
          // Not valid JSON — could be debug output from the Nano, ignore
        }
      }
    }
  } catch (err) {
    if (serial.connected) {
      addLog('Serial read error: ' + err.message, 'danger');
    }
  } finally {
    serial.reader.releaseLock();
    await serialDisconnect();
  }
}

/**
 * Close the serial port cleanly.
 * Dispatches 'ember:serial' with { connected: false }.
 */
async function serialDisconnect() {
  const wasConnected = serial.connected;
  serial.connected = false;

  try {
    if (serial.reader) { await serial.reader.cancel(); serial.reader = null; }
    if (serial.writer) { await serial.writer.close(); serial.writer = null; }
    if (serial._inputDone) { await serial._inputDone.catch(() => {}); serial._inputDone = null; }
    if (serial._outputDone) { await serial._outputDone.catch(() => {}); serial._outputDone = null; }
    if (serial.port) { await serial.port.close(); serial.port = null; }
  } catch { /* swallow close errors */ }

  if (wasConnected) {
    window.dispatchEvent(new CustomEvent('ember:serial', { detail: { connected: false } }));
    addLog('Serial port disconnected', 'warning');
  }
}

/**
 * Write a string to the serial port (e.g. "BUZZ:1\n").
 * Returns false if not connected.
 */
async function serialWrite(str) {
  if (!serial.writer) return false;
  try {
    await serial.writer.write(str);
    return true;
  } catch (err) {
    addLog('Serial write failed: ' + err.message, 'danger');
    return false;
  }
}
