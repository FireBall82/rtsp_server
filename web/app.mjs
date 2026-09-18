import { Publisher, CancelledError, cameraError } from './media.mjs';

const ui = Object.fromEntries(['start', 'stop', 'preview', 'placeholder', 'status', 'message',
  'badge', 'zoom', 'zoom-value', 'zoom-mode', 'camera-auto', 'stream-quality', 'rtsp', 'copy'].map(id => [id, document.getElementById(id)]));
let current = null;
let stopping = false;
let config;
let screenLock;
let requestingScreenLock = false;
const monitor = document.querySelector('.monitor');
const previewLabel = document.querySelector('.preview-label');

async function keepScreenAwake() {
  const publisher = current;
  if (!publisher || publisher.cancelled || screenLock || requestingScreenLock || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
  requestingScreenLock = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (current !== publisher || publisher.cancelled) { await lock.release(); return; }
    screenLock = lock;
    lock.addEventListener('release', () => { if (screenLock === lock) screenLock = null; }, { once: true });
  } catch (error) { console.warn('Screen wake lock unavailable:', error.name); }
  finally { requestingScreenLock = false; }
}

function releaseScreenLock() {
  const lock = screenLock; screenLock = null;
  if (lock) void lock.release().catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (!current || current.cancelled) return;
  if (document.visibilityState === 'visible') void keepScreenAwake();
  else ui.message.textContent = 'Keep this camera page visible and the phone unlocked. Background capture may pause.';
});

function syncPreviewSize() {
  const { videoWidth: width, videoHeight: height } = ui.preview;
  if (!ui.preview.srcObject || !width || !height) return;
  monitor.style.setProperty('--camera-aspect', `${width} / ${height}`);
  previewLabel.textContent = `${width} × ${height} · PREVIEW`;
}
ui.preview.addEventListener('loadedmetadata', syncPreviewSize);
ui.preview.addEventListener('resize', syncPreviewSize);

function state(name, message) {
  document.body.dataset.live = String(name === 'live');
  document.body.dataset.error = String(name === 'error' || name === 'cleanup-warning');
  ui.status.textContent = { idle: 'Ready', starting: 'Permission', connecting: 'Connecting',
    live: 'Streaming', reconnecting: 'Reconnecting', stopping: 'Stopping', error: 'Stopped', 'cleanup-warning': 'Stopped' }[name] || name;
  ui.badge.textContent = name === 'live' ? 'LIVE' : 'STANDBY';
  ui.message.textContent = message || { idle: 'Rear camera preferred. Camera permission is required. Video only; no microphone.',
    starting: 'Allow camera access in the browser prompt. You can press Stop to cancel.',
    connecting: 'Connecting your camera to go2rtc…', reconnecting: 'Reconnecting while keeping the camera open…', live: 'Your camera is streaming. Zoom changes the RTSP image.',
    stopping: 'Releasing the camera and closing the stream…' }[name] || '';
}

function syncZoom(source) {
  const zoom = source.zoom;
  Object.assign(ui.zoom, { min: zoom.min, max: zoom.max, step: zoom.step, value: zoom.value,
    disabled: zoom.mode === 'unavailable' });
  ui['zoom-value'].textContent = `${zoom.value.toFixed(1)}×`;
  ui['zoom-mode'].textContent = { native: 'Camera zoom · affects the transmitted video.',
    digital: `Digital zoom · ${source.interpolation === 'bicubic' ? 'GPU bicubic' : 'high-quality'} enlargement to the full output frame.`,
    unavailable: 'This browser and camera do not support streaming zoom.' }[zoom.mode];
  const labels = { continuous: 'continuous', 'camera-managed': 'camera managed (not confirmed)',
    unavailable: 'continuous mode unavailable', unconfirmed: 'not confirmed', failed: 'automatic mode request failed' };
  ui['camera-auto'].textContent = `Autofocus: ${labels[source.automatic.focusMode]} · Auto exposure: ${labels[source.automatic.exposureMode]}`;
}

ui.start.addEventListener('click', async () => {
  if (current || stopping || !config) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    state('error', 'Camera access requires HTTPS or http://localhost and a browser with camera support.');
    return;
  }
  if (!window.RTCPeerConnection) { state('error', 'This browser does not support WebRTC. Try a current browser.'); return; }
  ui.start.disabled = true;
  ui.stop.disabled = false;
  const endpoint = new URL(`api/webrtc?dst=${encodeURIComponent(config.stream)}`, location.href).href;
  const publisher = new Publisher({ endpoint, iceServers: config.iceServers, mediaTransport: config.mediaTransport || 'tcp',
    onMetrics: metrics => {
      if (current !== publisher) return;
      if (!metrics) { ui['stream-quality'].textContent = 'Transmission quality appears after connecting.'; return; }
      const source = publisher.source.track.getSettings();
      const dimensions = metrics.width && metrics.height ? `${metrics.width} × ${metrics.height}` : 'Measuring resolution';
      const fps = Number.isFinite(metrics.fps) ? `${metrics.fps.toFixed(0)} fps` : 'Measuring fps';
      const bitrate = metrics.bitrate === null ? 'Measuring bitrate' : `${(metrics.bitrate / 1e6).toFixed(1)} Mbps`;
      const limitation = { cpu: ' · device processing limited', bandwidth: ' · network limited', other: ' · encoder limited' }[metrics.limitation] || '';
      ui['stream-quality'].textContent = `Camera: ${source.width} × ${source.height} · Sent: ${dimensions} · ${fps} · ${bitrate} · ${(metrics.protocol || config.mediaTransport || 'auto').toUpperCase()}${limitation}`;
    },
    onPreview: stream => {
      if (current !== publisher) return;
      ui.preview.srcObject = stream;
      ui.preview.style.display = stream ? 'block' : 'none';
      ui.placeholder.style.display = stream ? 'none' : 'flex';
      if (stream) { syncZoom(publisher.source); void ui.preview.play().catch(() => {}); }
      else {
        monitor.style.removeProperty('--camera-aspect'); previewLabel.textContent = 'OUTGOING PREVIEW';
        ui['camera-auto'].textContent = 'Automatic focus and exposure checked after starting.';
      }
    },
    onState: (name, message) => {
      if (current !== publisher) return;
      state(name, message);
      if (name === 'live') void keepScreenAwake();
      if (name === 'error') { releaseScreenLock(); current = null; ui.start.disabled = false; ui.stop.disabled = true; ui.zoom.disabled = true; }
    },
  });
  current = publisher;
  try { await publisher.start(); }
  catch (error) {
    if (current !== publisher) return;
    current = null;
    releaseScreenLock();
    ui.start.disabled = false;
    ui.stop.disabled = true;
    ui.zoom.disabled = true;
    state(error instanceof CancelledError ? 'idle' : 'error', error instanceof CancelledError ? undefined : cameraError(error));
  }
});

ui.stop.addEventListener('click', async () => {
  if (!current || stopping) return;
  stopping = true;
  const publisher = current;
  state('stopping');
  ui.stop.disabled = true;
  ui.zoom.disabled = true;
  releaseScreenLock();
  await publisher.stop();
  if (current === publisher) current = null;
  stopping = false;
  ui.start.disabled = false;
  if (document.body.dataset.error !== 'true') state('idle');
});

// Serialize camera constraints and coalesce fast slider events.
let desiredZoom = null;
let applyingZoom = false;
ui.zoom.addEventListener('input', async () => {
  desiredZoom = Number(ui.zoom.value);
  if (applyingZoom) return;
  applyingZoom = true;
  const publisher = current;
  try {
    while (desiredZoom !== null && publisher && current === publisher && !publisher.cancelled) {
      const value = desiredZoom;
      desiredZoom = null;
      await publisher.source.setZoom(value);
      syncZoom(publisher.source);
    }
  } catch (error) {
    if (current === publisher && !(error instanceof CancelledError)) {
      syncZoom(publisher.source);
      ui.message.textContent = cameraError(error);
    }
  } finally { desiredZoom = null; applyingZoom = false; }
});

ui.copy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(ui.rtsp.value); ui.copy.textContent = 'Copied'; }
  catch { ui.rtsp.focus(); ui.rtsp.select(); ui.message.textContent = 'Select and copy the RTSP address.'; }
  setTimeout(() => { ui.copy.textContent = 'Copy'; }, 1500);
});

window.addEventListener('pagehide', () => { releaseScreenLock(); if (current) void current.stop(true); });

try {
  const response = await fetch('config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load camera configuration.');
  config = await response.json();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.stream) || !Array.isArray(config.iceServers) ||
    !Number.isInteger(config.rtspPort) || config.rtspPort < 1 || config.rtspPort > 65535 ||
    (config.mediaTransport !== undefined && !['tcp', 'auto'].includes(config.mediaTransport))) {
    throw new Error('Invalid camera configuration.');
  }
  const host = config.rtspHost || location.hostname;
  ui.rtsp.value = `rtsp://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${config.rtspPort}/${config.stream}`;
} catch (error) { config = null; ui.start.disabled = true; state('error', cameraError(error)); }
