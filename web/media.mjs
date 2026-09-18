import { VIDEO_FPS, VIDEO_BITRATE, qualitySdp, transportSdp, videoStats } from './stream.mjs';
import { createBicubicUpscaler } from './upscale.mjs';

export class CancelledError extends Error {
  constructor() { super('Camera startup was cancelled.'); }
}

const IMAGE_CONTROLS = new Set(['whiteBalanceMode', 'exposureMode', 'focusMode', 'pointsOfInterest',
  'exposureCompensation', 'exposureTime', 'colorTemperature', 'iso', 'brightness', 'contrast',
  'saturation', 'sharpness', 'focusDistance', 'pan', 'tilt', 'zoom', 'torch']);

function outputSize(width, height, upscale = false) {
  const landscape = width >= height;
  const scale = Math.min(upscale ? Infinity : 1, (landscape ? 1920 : 1080) / width, (landscape ? 1080 : 1920) / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function cropRect(width, height, zoom) {
  if (![width, height, zoom].every(Number.isFinite) || width <= 0 || height <= 0 || zoom < 1) {
    throw new RangeError('Invalid camera dimensions or zoom.');
  }
  return { x: (width - width / zoom) / 2, y: (height - height / zoom) / 2,
    width: width / zoom, height: height / zoom };
}

// go2rtc returns `webrtc?id=...`, relative to `/api/webrtc?dst=...`.
export function whipResource(location, endpoint) {
  if (!location) throw new Error('go2rtc did not return a publishing session.');
  const base = new URL(endpoint);
  const resource = new URL(location, base);
  const ids = resource.searchParams.getAll('id');
  if (resource.origin !== base.origin || resource.pathname !== base.pathname ||
      resource.username || resource.password || resource.hash ||
      [...resource.searchParams.keys()].some(key => key !== 'id') ||
      ids.length !== 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(ids[0])) {
    throw new Error('go2rtc returned an invalid publishing session URL.');
  }
  return resource.href;
}

export function cameraError(error) {
  const messages = {
    NotAllowedError: 'Camera permission was denied. Allow camera access in your browser and try again.',
    NotFoundError: 'No camera was found. Connect a camera and try again.',
    NotReadableError: 'The camera is busy or unavailable. Close other camera apps and try again.',
    OverconstrainedError: 'This camera does not support the requested capture settings.',
    TimeoutError: 'The connection timed out. Check go2rtc and the WebRTC network ports.',
    AbortError: 'The camera or connection was interrupted. Try again.',
  };
  return messages[error?.name] || error?.message || 'Could not start the camera.';
}

export class CameraSource {
  constructor(deps = {}) {
    this.deps = {
      getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
      createVideo: () => document.createElement('video'),
      createCanvas: () => document.createElement('canvas'),
      setInterval: (...args) => globalThis.setInterval(...args),
      clearInterval: value => globalThis.clearInterval(value),
      now: () => performance.now(), ...deps,
    };
    this.closed = false;
    this.digitalZoom = 1;
    this.zoom = { mode: 'unavailable', min: 1, max: 1, step: 0.1, value: 1 };
    this.automatic = { focusMode: 'camera-managed', exposureMode: 'camera-managed' };
  }

  async start() {
    try {
      // Request zoom access too where supported (PTZ-capable cameras may prompt).
      this.constraints = { facingMode: { ideal: 'environment' },
          width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1920 },
          frameRate: { ideal: VIDEO_FPS, max: VIDEO_FPS }, resizeMode: { ideal: 'none' }, zoom: true };
      this.raw = await this.deps.getUserMedia({ audio: false, video: this.constraints });
      if (this.closed) { this.stop(); throw new CancelledError(); }
      this.track = this.raw.getVideoTracks()[0];
      if (!this.track) throw new Error('The camera did not provide a video track.');
      await this.ensureAutomaticControls();
      const settings = this.track.getSettings?.() || {};
      const capabilities = this.track.getCapabilities?.() || {};
      const native = capabilities.zoom;
      if (native && Number.isFinite(native.min) && Number.isFinite(native.max) && native.max > native.min) {
        this.zoom = { mode: 'native', min: native.min, max: native.max,
          step: native.step > 0 ? native.step : 0.1, value: settings.zoom ?? native.min };
      }
      this.output = this.raw;
      this.setContentHint(this.output);
      // Hardware zoom and unmodified 1x frames can be encoded straight from the camera.
      if (this.zoom.mode !== 'native') {
        this.canvas = this.deps.createCanvas();
        if (typeof this.canvas.captureStream === 'function') this.useDigitalZoom();
      }
      const size = outputSize(settings.width || 1920, settings.height || 1080);
      this.needsScaling = !!settings.width && !!settings.height &&
        (size.width !== settings.width || size.height !== settings.height);
      if (this.needsScaling) {
        if (!this.canvas) this.canvas = this.deps.createCanvas();
        if (typeof this.canvas.captureStream === 'function') await this.enableCanvas();
      }
      return this.output;
    } catch (error) { this.stop(); throw error; }
  }

  async setOutput(output) {
    if (this.closed) throw new CancelledError();
    const previous = this.output;
    this.setContentHint(output);
    this.output = output;
    try { await this.onOutput?.(output); }
    catch (error) { this.output = previous; throw error; }
    if (this.closed) throw new CancelledError();
  }

  setContentHint(stream) {
    const track = stream.getVideoTracks()[0];
    if (track && 'contentHint' in track) track.contentHint = 'detail';
  }

  async enableCanvas() {
    if (this.canvasOutput) return;
    this.canvas ||= this.deps.createCanvas();
    if (typeof this.canvas.captureStream !== 'function') {
      throw new Error('Hardware zoom is unavailable and this browser cannot enlarge streaming video.');
    }
    try {
      this.video = this.deps.createVideo();
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = this.raw;
      await this.video.play();
      if (this.closed) throw new CancelledError();
      this.context = this.canvas.getContext('2d', { alpha: false });
      if (!this.context) throw new Error('Canvas video capture is unavailable in this browser.');
      this.browserQuality = 'imageSmoothingQuality' in this.context;
      if (!this.browserQuality && typeof document !== 'undefined') {
        this.upscaler = createBicubicUpscaler();
      }
      this.drawFrame();
      this.canvasOutput = this.canvas.captureStream(VIDEO_FPS);
      if (!this.canvasOutput.getVideoTracks()[0]) throw new Error('Canvas capture did not provide a video track.');
      if (typeof this.video.requestVideoFrameCallback === 'function' &&
          typeof this.video.cancelVideoFrameCallback === 'function') {
        const next = (now) => {
          if (this.closed || !this.video) return;
          this.lastCallbackAt = this.deps.now();
          if (this.lastFrameAt === undefined || now - this.lastFrameAt >= 1000 / VIDEO_FPS - 1) {
            this.drawFrame(); this.lastFrameAt = now;
          }
          this.frameCallback = this.video.requestVideoFrameCallback(next);
        };
        this.frameCallback = this.video.requestVideoFrameCallback(next);
        this.lastCallbackAt = this.deps.now();
        // Detached/hidden video frame callbacks can stall in mobile browsers.
        // Follow advancing camera timestamps until callbacks resume.
        this.watchdog = this.deps.setInterval(() => {
          if (this.deps.now() - this.lastCallbackAt > 250) this.drawNewFrame();
        }, 1000 / VIDEO_FPS);
      } else {
        // Older browsers: skip unchanged frames rather than redrawing duplicates.
        this.timer = this.deps.setInterval(() => {
          this.drawNewFrame();
        }, 1000 / VIDEO_FPS);
      }
      await this.setOutput(this.canvasOutput);
    } catch (error) { this.stopRendering(); throw error; }
  }

  drawNewFrame() {
    const time = this.video?.currentTime;
    if (typeof time === 'number' && time === this.lastMediaTime) return;
    this.drawFrame();
  }

  drawFrame() {
    if (this.closed || !this.video?.videoWidth || !this.video.videoHeight) return;
    const { videoWidth: width, videoHeight: height } = this.video;
    this.lastMediaTime = this.video.currentTime;
    const size = outputSize(width, height, this.digitalZoom > 1);
    if (this.canvas.width !== size.width) this.canvas.width = size.width;
    if (this.canvas.height !== size.height) this.canvas.height = size.height;
    // Resizing resets context state, so set interpolation quality after sizing.
    this.context.imageSmoothingEnabled = true;
    if (this.browserQuality) this.context.imageSmoothingQuality = 'high';
    const crop = cropRect(width, height, this.digitalZoom);
    const enhanced = this.digitalZoom > 1 && this.upscaler?.draw(this.video, crop, size);
    this.interpolation = enhanced ? 'bicubic' : (this.browserQuality ? 'browser-high' : 'browser-default');
    if (enhanced) this.context.drawImage(enhanced, 0, 0);
    else this.context.drawImage(this.video, crop.x, crop.y, crop.width, crop.height,
      0, 0, this.canvas.width, this.canvas.height);
  }

  stopRendering() {
    if (this.timer !== undefined) this.deps.clearInterval(this.timer);
    if (this.watchdog !== undefined) this.deps.clearInterval(this.watchdog);
    if (this.frameCallback !== undefined) this.video?.cancelVideoFrameCallback?.(this.frameCallback);
    this.timer = this.watchdog = this.frameCallback = undefined;
    this.lastFrameAt = this.lastMediaTime = undefined;
    for (const track of this.canvasOutput?.getTracks() || []) track.stop();
    this.canvasOutput = undefined;
    this.upscaler?.dispose(); this.upscaler = undefined;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.video = undefined;
  }

  async applyTrackSettings(overrides) {
    if (this.closed) throw new CancelledError();
    // applyConstraints replaces the constraint set. Keep capture quality and other controls.
    const current = this.track.getConstraints?.() || this.constraints;
    const constraints = { ...current };
    for (const key of Object.keys(overrides)) delete constraints[key];
    const advanced = (current.advanced || []).map(entry => {
      const preserved = { ...entry };
      for (const key of Object.keys(overrides)) delete preserved[key];
      return preserved;
    }).filter(entry => Object.keys(entry).length);
    constraints.advanced = [...advanced, { ...overrides }];
    try { await this.track.applyConstraints(constraints); }
    catch (error) {
      if (this.closed) throw new CancelledError();
      // Chromium processes camera controls separately and rejects mixed constraint sets.
      // Its image-only path retains the existing resolution/frame-rate constraints.
      if (!/Mixing ImageCapture and non-ImageCapture/i.test(error.message || '')) throw error;
      const imageOnly = Object.fromEntries(Object.entries(constraints).filter(([key]) => IMAGE_CONTROLS.has(key)));
      imageOnly.advanced = constraints.advanced.map(entry =>
        Object.fromEntries(Object.entries(entry).filter(([key]) => IMAGE_CONTROLS.has(key))))
        .filter(entry => Object.keys(entry).length);
      await this.track.applyConstraints(imageOnly);
    }
    if (this.closed) throw new CancelledError();
    this.constraints = constraints;
  }

  async ensureAutomaticControls() {
    const capabilities = this.track.getCapabilities?.() || {};
    // Apply independently: rejected autofocus must not prevent automatic exposure.
    for (const mode of ['focusMode', 'exposureMode']) {
      if (this.closed) throw new CancelledError();
      const supported = capabilities[mode];
      if (this.track.getSettings?.()[mode] === 'continuous') {
        this.automatic[mode] = 'continuous';
        continue;
      }
      if (!Array.isArray(supported) || !supported.includes('continuous')) {
        this.automatic[mode] = Array.isArray(supported) && supported.length ? 'unavailable' : 'camera-managed';
        continue;
      }
      if (typeof this.track.applyConstraints !== 'function') {
        this.automatic[mode] = 'unconfirmed';
        continue;
      }
      try {
        await this.applyTrackSettings({ [mode]: 'continuous' });
        // Some browsers silently ignore image-capture constraints; don't claim success.
        this.automatic[mode] = this.track.getSettings?.()[mode] === 'continuous' ? 'continuous' : 'unconfirmed';
      } catch (error) {
        if (this.closed) throw new CancelledError();
        this.automatic[mode] = 'failed';
      }
    }
    // A driver can reset another control when one is changed; report final settings.
    const settings = this.track.getSettings?.() || {};
    for (const mode of ['focusMode', 'exposureMode']) {
      if (settings[mode] === 'continuous') this.automatic[mode] = 'continuous';
      else if (this.automatic[mode] === 'continuous') this.automatic[mode] = 'unconfirmed';
    }
  }

  useDigitalZoom() {
    this.canvas ||= this.deps.createCanvas();
    if (typeof this.canvas.captureStream !== 'function') {
      this.zoom = { mode: 'unavailable', min: 1, max: 1, step: 0.1, value: 1 };
      throw new Error('Camera zoom failed, and this browser cannot capture digital zoom.');
    }
    this.digitalZoom = 1;
    this.zoom = { mode: 'digital', min: 1, max: 4, step: 0.1, value: 1 };
  }

  async setCaptureResolution(detailed) {
    const capabilities = this.track.getCapabilities?.() || {};
    if (detailed && (!(capabilities.width?.max > 1920) || !(capabilities.height?.max > 1080))) return;
    const current = this.track.getConstraints?.() || this.constraints;
    // Core capture constraints must use their own path in Chromium. Image modes
    // are rechecked afterward and never mixed with width/height changes.
    const constraints = Object.fromEntries(Object.entries(current).filter(([key]) =>
      key !== 'advanced' && !IMAGE_CONTROLS.has(key)));
    constraints.width = { ideal: detailed ? 3840 : 1920, max: detailed ? 3840 : 1920 };
    constraints.height = { ideal: detailed ? 2160 : 1080, max: detailed ? 3840 : 1920 };
    constraints.frameRate = { ideal: VIDEO_FPS, max: VIDEO_FPS };
    constraints.advanced = (current.advanced || []).map(entry => Object.fromEntries(
      Object.entries(entry).filter(([key]) => !IMAGE_CONTROLS.has(key) && !['width', 'height', 'frameRate'].includes(key))))
      .filter(entry => Object.keys(entry).length);
    try {
      await this.track.applyConstraints(constraints);
      if (this.closed) throw new CancelledError();
      this.detailedCapture = detailed;
      await this.ensureAutomaticControls();
      const settings = this.track.getSettings?.() || {};
      const size = outputSize(settings.width || 1920, settings.height || 1080);
      this.needsScaling = size.width !== settings.width || size.height !== settings.height;
    } catch (error) {
      if (this.closed) throw new CancelledError();
      console.warn('Camera retained its current capture resolution:', error.name);
    }
  }

  async setZoom(value) {
    if (this.closed) throw new CancelledError();
    if (!Number.isFinite(value) || value < this.zoom.min || value > this.zoom.max) {
      throw new RangeError('Zoom is outside the supported camera range.');
    }
    if (this.zoom.mode === 'native') {
      try {
        await this.applyTrackSettings({ zoom: value });
        if (this.closed) throw new CancelledError();
        const applied = this.track.getSettings?.().zoom;
        if (typeof applied !== 'number' || Math.abs(applied - value) > this.zoom.step) {
          throw new Error('Camera did not apply zoom.');
        }
        this.zoom.value = applied;
        await this.ensureAutomaticControls();
        return this.zoom;
      } catch (error) {
        if (this.closed) throw new CancelledError();
        // Reset hardware zoom where possible before switching to software zoom.
        try { await this.applyTrackSettings({ zoom: this.zoom.min }); } catch { /* Keep the current camera field of view. */ }
        if (this.closed) throw new CancelledError();
        await this.ensureAutomaticControls();
        this.useDigitalZoom();
        value = Math.max(1, Math.min(4, value));
      }
    }
    if (this.zoom.mode === 'unavailable') throw new Error('Zoom is unavailable in this browser.');
    const previous = this.digitalZoom;
    this.digitalZoom = value;
    this.zoom.value = value;
    try {
      if (value > 1 && !this.detailedCapture) await this.setCaptureResolution(true);
      if (value === 1 && this.detailedCapture) await this.setCaptureResolution(false);
      if (value === 1 && !this.needsScaling) {
        if (this.output !== this.raw) { await this.setOutput(this.raw); this.stopRendering(); }
      } else {
        const rendering = !!this.canvasOutput;
        await this.enableCanvas();
        if (rendering) this.drawFrame();
      }
    } catch (error) {
      this.digitalZoom = previous;
      this.zoom.value = previous;
      if (previous === 1 && this.detailedCapture) await this.setCaptureResolution(false);
      throw error;
    }
    return this.zoom;
  }

  stop() {
    this.closed = true;
    const tracks = new Set([...(this.raw?.getTracks() || []), ...(this.output?.getTracks() || [])]);
    for (const track of tracks) track.stop();
    this.stopRendering();
  }
}

export function waitForIce(pc, signal, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      signal.removeEventListener('abort', cancel);
      error ? reject(error) : resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const cancel = () => finish(new CancelledError());
    if (signal.aborted) { reject(new CancelledError()); return; }
    pc.addEventListener('icegatheringstatechange', check);
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => finish(new Error('ICE gathering timed out. Check your network and try again.')), timeout);
    check();
  });
}

export class Publisher {
  constructor({ endpoint, iceServers = [], onState = () => {}, onPreview = () => {},
    source = new CameraSource(), fetcher = (...args) => fetch(...args),
    createPeer = config => new RTCPeerConnection(config), mediaTransport = 'auto',
    onMetrics = () => {}, timers = globalThis }) {
    this.endpoint = endpoint;
    this.iceServers = iceServers;
    this.onState = onState;
    this.onPreview = onPreview;
    this.source = source;
    this.fetcher = fetcher;
    this.createPeer = createPeer;
    this.mediaTransport = mediaTransport;
    this.onMetrics = onMetrics;
    this.timers = timers;
    this.retryCount = 0;
    this.source.onOutput = async output => {
      if (this.cancelled) throw new CancelledError();
      if (this.sender) {
        try { await this.sender.replaceTrack(output.getVideoTracks()[0]); }
        catch (error) { throw new Error(`The browser could not switch zoom video (${error.name}). Restart the camera and try again.`); }
      }
      if (this.cancelled) throw new CancelledError();
      this.onPreview(output);
    };
    this.abortIce = new AbortController();
    this.cancelled = false;
  }

  async start() {
    try {
      this.onState('starting');
      const getCapabilities = globalThis.RTCRtpSender?.getCapabilities;
      const codecs = getCapabilities ? globalThis.RTCRtpSender.getCapabilities('video')?.codecs || [] : [];
      const h264 = codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264');
      if (getCapabilities && !h264.length) {
        throw new Error('This browser cannot encode H.264, which go2rtc needs for this camera stream. Use a browser with H.264 WebRTC encoding enabled.');
      }
      await this.source.start();
      if (this.cancelled) throw new CancelledError();
      this.h264 = h264;
      this.codecs = codecs;
      this.onPreview(this.source.output);
      this.source.track.addEventListener?.('ended', () => {
        if (!this.cancelled) void this.stop().then(() => this.onState('error', 'The camera disconnected. Connect it and start again.'));
      }, { once: true });
      await this.connect();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async connect() {
    this.connecting = true;
    try { await this.connectPeer(); }
    finally {
      this.connecting = false;
      if (!this.recovering && this.pendingRecovery) {
        const pending = this.pendingRecovery; this.pendingRecovery = null;
        this.queueReconnect(pending.delay, pending.message);
      }
    }
  }

  async connectPeer() {
    if (this.cancelled) throw new CancelledError();
    const output = this.source.output;
    const h264 = this.h264;
    const codecs = this.codecs;
    const pc = this.createPeer({ iceServers: this.iceServers });
    this.pc = pc;
    this.abortIce = new AbortController();
    pc.onconnectionstatechange = () => {
      if (this.cancelled || this.pc !== pc) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        this.timers.clearTimeout(this.connectionTimer);
        this.timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
        this.retryCount = 0;
        this.pendingRecovery = null;
        this.onState('live');
      }
      if (state === 'disconnected') this.queueReconnect(5000, 'Connection interrupted. Keeping the camera open while reconnecting…');
      if (state === 'failed' || state === 'closed') this.queueReconnect(1000);
    };
    const transceiver = pc.addTransceiver(output.getVideoTracks()[0], { direction: 'sendonly', streams: [output],
      sendEncodings: [{ maxBitrate: VIDEO_BITRATE, maxFramerate: VIDEO_FPS, scaleResolutionDownBy: 1 }] });
    this.sender = transceiver.sender;
    if (h264.length && transceiver.setCodecPreferences) {
      transceiver.setCodecPreferences([...h264, ...codecs.filter(codec =>
        ['video/rtx', 'video/red', 'video/ulpfec'].includes(codec.mimeType.toLowerCase()))]);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription({ ...offer, sdp: qualitySdp(offer.sdp) });
    await waitForIce(pc, this.abortIce.signal);
    if (this.cancelled) throw new CancelledError();
    this.onState(this.retryCount ? 'reconnecting' : 'connecting');
    // Do not abort POST on Stop: consume a late Location and delete that resource.
    const response = await this.fetcher(this.endpoint, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp,
      signal: AbortSignal.timeout(20000) });
    if (response.status !== 201) throw new Error(`go2rtc could not accept the camera (HTTP ${response.status}). Check the configured stream.`);
    this.resource = whipResource(response.headers.get('Location'), this.endpoint);
    if (this.cancelled) throw new CancelledError();
    const answer = await response.text();
    if (!answer.startsWith('v=0')) throw new Error('go2rtc returned an invalid SDP answer.');
    if (/^m=video\s+0\s/m.test(answer)) {
      throw new Error('go2rtc rejected the video codec. Use a browser with H.264 WebRTC encoding enabled.');
    }
    if (this.cancelled) throw new CancelledError();
    await pc.setRemoteDescription({ type: 'answer', sdp: transportSdp(qualitySdp(answer), this.mediaTransport) });
    if (this.cancelled) throw new CancelledError();
    // Preserve image detail under congestion; unsupported tuning must not stop capture.
    const sender = transceiver.sender;
    if (sender?.getParameters && sender?.setParameters) {
      try {
        const parameters = sender.getParameters();
        if (parameters.encodings?.length) {
          for (const encoding of parameters.encodings) {
            Object.assign(encoding, { maxBitrate: VIDEO_BITRATE, maxFramerate: VIDEO_FPS, scaleResolutionDownBy: 1 });
          }
          parameters.degradationPreference = 'maintain-resolution';
          await sender.setParameters(parameters);
        }
      } catch (error) { console.warn('Browser retained its default video encoding settings:', error.name); }
    }
    if (this.cancelled) throw new CancelledError();
    if (pc.connectionState !== 'connected') {
      this.connectionTimer = this.timers.setTimeout(() => {
        if (!this.cancelled && this.pc === pc) this.queueReconnect(0, 'Media connection timed out. Retrying…');
      }, 15000);
    } else {
      this.retryCount = 0;
      this.onState('live');
    }
    this.startMetrics(pc);
  }

  queueReconnect(delay, message = 'Reconnecting the camera stream…') {
    if (this.cancelled) return;
    if (this.recovering || this.connecting) {
      this.pendingRecovery = { delay, message }; return;
    }
    if (this.reconnectTimer !== undefined) {
      if (delay > 1000) return;
      this.timers.clearTimeout(this.reconnectTimer);
    }
    this.onState('reconnecting', message);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
  }

  async reconnect() {
    if (this.cancelled || this.recovering) return;
    this.recovering = true;
    this.retryCount++;
    let failure;
    try {
      await this.releasePeer();
      if (this.cancelled) return;
      if (this.retryCount > 6) throw new Error('The media connection repeatedly failed. Check TCP port 8555 and the network, then start again.');
      await this.connect();
    } catch (error) { failure = error; }
    finally { this.recovering = false; }
    if (this.cancelled) { await this.releasePeer(); return; }
    if (failure) {
      await this.releasePeer();
      if (this.cancelled) return;
      if (this.retryCount > 6) {
        await this.stop(); this.onState('error', cameraError(failure));
      } else this.queueReconnect(Math.min(15000, 1000 * 2 ** (this.retryCount - 1)), `Reconnecting (${this.retryCount}/6): ${cameraError(failure)}`);
    } else if (this.pendingRecovery) {
      const pending = this.pendingRecovery; this.pendingRecovery = null;
      this.queueReconnect(pending.delay, pending.message);
    }
  }

  startMetrics(pc) {
    if (!pc.getStats) return;
    this.previousStats = null;
    this.stalledFor = 0;
    this.metricsTimer = this.timers.setInterval(async () => {
      if (this.cancelled || this.pc !== pc || this.readingStats) return;
      // close() need not dispatch connectionstatechange in every browser.
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        this.queueReconnect(0); return;
      }
      this.readingStats = true;
      try {
        const report = await pc.getStats();
        if (this.cancelled || this.pc !== pc) return;
        const metrics = videoStats(report, this.previousStats);
        if (!metrics) return;
        if (pc.connectionState === 'connected' && this.previousStats?.id === metrics.id &&
            metrics.framesEncoded === this.previousStats.framesEncoded) {
          this.stalledFor += Math.max(0, metrics.timestamp - this.previousStats.timestamp);
        } else this.stalledFor = 0;
        this.previousStats = metrics;
        this.onMetrics(metrics);
        if (this.stalledFor >= 10000) this.queueReconnect(0, 'Video encoding stalled. Reconnecting…');
      } catch (error) { console.warn('Could not read camera transmission metrics:', error.name); }
      finally { this.readingStats = false; }
    }, 2000);
  }

  async stop(keepalive = false) {
    this.cancelled = true;
    this.pendingRecovery = null;
    this.timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    this.source.stop();
    this.onPreview(null);
    this.onMetrics(null);
    await this.releasePeer(keepalive);
  }

  async releasePeer(keepalive = false) {
    this.abortIce.abort();
    this.timers.clearTimeout(this.connectionTimer);
    this.timers.clearInterval(this.metricsTimer); this.metricsTimer = undefined;
    if (this.pc) { this.pc.onconnectionstatechange = null; this.pc.close(); }
    this.pc = null; this.sender = null;
    if (!this.resource) return;
    const resource = this.resource;
    try {
      const response = await this.fetcher(resource, { method: 'DELETE', redirect: 'error',
        keepalive, signal: AbortSignal.timeout(4000) });
      if (response.ok || response.status === 404) {
        if (this.resource === resource) this.resource = null;
      } else {
        this.onState(this.cancelled ? 'cleanup-warning' : 'reconnecting', 'Server cleanup failed; the closed connection will time out.');
      }
    } catch {
      this.onState(this.cancelled ? 'cleanup-warning' : 'reconnecting', 'Server cleanup could not be reached; the closed connection will time out.');
    }
  }
}
