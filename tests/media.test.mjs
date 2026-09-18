import test from 'node:test';
import assert from 'node:assert/strict';
import { cropRect, whipResource, CameraSource, Publisher, CancelledError, waitForIce, cameraError } from '../web/media.mjs';
import { qualitySdp, transportSdp, videoStats } from '../web/stream.mjs';

const endpoint = 'http://localhost:1984/api/webrtc?dst=camera';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function capture({ native = false, canvas = true, permission, playFailure = false,
  videoWidth = 1920, videoHeight = 1080, trackWidth = videoWidth, trackHeight = videoHeight, automatic = false } = {}) {
  let frame;
  let cleared = false;
  let appliedZoom = 1;
  let appliedConstraints;
  const modes = automatic ? { focusMode: 'manual', exposureMode: 'manual' } : {};
  const draws = [];
  const rawTrack = { stopped: false, stop() { this.stopped = true; },
    getSettings: () => ({ width: trackWidth, height: trackHeight, zoom: appliedZoom, ...modes }),
    getConstraints: () => appliedConstraints,
    getCapabilities: () => ({ ...(native ? { zoom: { min: 1, max: 5, step: 0.25 } } : {}),
      ...(automatic ? { focusMode: ['manual', 'continuous'], exposureMode: ['manual', 'continuous'] } : {}) }),
    async applyConstraints(constraints) {
      for (const entry of constraints.advanced || []) {
        if (typeof entry.zoom === 'number') appliedZoom = entry.zoom;
        for (const key of ['focusMode', 'exposureMode']) if (entry[key]) modes[key] = entry[key];
      }
      appliedConstraints = constraints;
    },
  };
  const outputTrack = { stopped: false, stop() { this.stopped = true; } };
  const stream = track => ({ getVideoTracks: () => [track], getTracks: () => [track] });
  const raw = stream(rawTrack);
  const output = stream(outputTrack);
  const video = { videoWidth, videoHeight, async play() { if (playFailure) throw new Error('Video playback failed.'); }, pause() {} };
  const context = { imageSmoothingQuality: 'low', drawImage(...args) { draws.push(args); } };
  const canvasElement = { getContext: () => context };
  if (canvas) canvasElement.captureStream = () => output;
  let constraints;
  const source = new CameraSource({
    getUserMedia: async value => { constraints = value; appliedConstraints = value.video; return permission ? await permission : raw; },
    createVideo: () => video, createCanvas: () => canvasElement,
    setInterval: fn => { frame = fn; return 42; }, clearInterval: value => { cleared = value === 42; },
  });
  return { source, raw, rawTrack, output, outputTrack, draws, video, modes, context, canvas: canvasElement,
    frame: () => frame(), cleared: () => cleared, constraints: () => constraints };
}

class Peer extends EventTarget {
  iceGatheringState = 'complete';
  connectionState = 'connected';
  close() { this.closed = true; }
  addTransceiver(track, options) {
    this.sentTrack = track; this.direction = options.direction; this.encodings = options.sendEncodings;
    this.sender = { getParameters: () => ({ encodings: this.encodings.map(value => ({ ...value })) }),
      setParameters: async parameters => { if (this.encodingFailure) throw new Error('Unsupported tuning'); this.parameters = parameters; },
      replaceTrack: async track => {
        if (this.replacementFailure) throw new DOMException('Cannot replace', 'InvalidModificationError');
        this.sentTrack = track; (this.replacements ||= []).push(track);
      } };
    return { sender: this.sender, setCodecPreferences: codecs => { this.codecPreferences = codecs; } };
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
  async setLocalDescription(offer) { this.localDescription = offer; }
  async setRemoteDescription(answer) { this.answer = answer; }
}

function publishing(fetcher, source = capture().source) {
  const peer = new Peer();
  const previews = [];
  const states = [];
  const publisher = new Publisher({ endpoint, source, createPeer: () => peer, fetcher,
    onPreview: stream => previews.push(stream), onState: (...args) => states.push(args) });
  return { publisher, peer, source, previews, states };
}

const answer = () => new Response('v=0\r\n', { status: 201, headers: { Location: 'webrtc?id=abc123' } });

function fakeTimers() {
  let id = 0;
  const timeouts = new Map(), intervals = new Map();
  return { timeouts, intervals,
    setTimeout: (fn, delay) => { timeouts.set(++id, { fn, delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: (fn, delay) => { intervals.set(++id, { fn, delay }); return id; },
    clearInterval: id => intervals.delete(id),
  };
}

function recoveryFixture({ fetcher, metrics = false } = {}) {
  const fixture = capture(), timers = fakeTimers(), peers = [], requests = [], states = [], reports = [];
  const publisher = new Publisher({ endpoint, source: fixture.source, timers,
    onState: (...value) => states.push(value), onMetrics: value => reports.push(value),
    createPeer: () => {
      const peer = new Peer();
      if (metrics) peer.getStats = async () => peer.stats;
      peers.push(peer); return peer;
    },
    fetcher: async (url, options) => {
      requests.push({ url, method: options.method });
      if (fetcher) return fetcher(url, options, requests);
      return options.method === 'POST' ? new Response('v=0\r\n', { status: 201,
        headers: { Location: `webrtc?id=session${peers.length}` } }) : new Response(null, { status: 200 });
    },
  });
  return { ...fixture, publisher, timers, peers, requests, states, reports };
}

test('temporary disconnection retains camera and cancels recovery if the same peer recovers', async () => {
  const f = recoveryFixture(); await f.publisher.start();
  const peer = f.peers[0];
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange();
  assert.equal(f.rawTrack.stopped, false);
  assert.equal(peer.closed, undefined);
  assert.equal([...f.timers.timeouts.values()][0].delay, 5000);
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  assert.equal(f.timers.timeouts.size, 0);
  assert.equal(f.requests.filter(value => value.method === 'POST').length, 1);
  await f.publisher.stop();
});

test('failed peer is rebuilt with the same live camera and old WHIP resource is deleted', async () => {
  const f = recoveryFixture(); await f.publisher.start();
  const peer = f.peers[0]; peer.connectionState = 'failed'; peer.onconnectionstatechange();
  const [id, timer] = [...f.timers.timeouts][0];
  assert.equal(timer.delay, 1000); f.timers.clearTimeout(id);
  await f.publisher.reconnect();
  assert.equal(f.peers.length, 2);
  assert.equal(peer.closed, true);
  assert.equal(f.rawTrack.stopped, false);
  assert.equal(f.peers[1].sentTrack, f.rawTrack);
  assert.deepEqual(f.requests.map(value => value.method), ['POST', 'DELETE', 'POST']);
  assert.ok(f.requests[1].url.endsWith('id=session1'));
  await f.publisher.stop(); assert.equal(f.timers.timeouts.size, 0);
});

test('Stop cancels recovery and consumes a late WHIP resource without reopening camera', async () => {
  const pending = deferred(); let posts = 0;
  const f = recoveryFixture({ fetcher: async (url, options) => {
    if (options.method !== 'POST') return new Response(null, { status: 200 });
    posts++; return posts === 1 ? answer() : pending.promise;
  } });
  await f.publisher.start();
  const recovering = f.publisher.reconnect();
  await new Promise(setImmediate);
  assert.equal(posts, 2);
  await f.publisher.stop();
  assert.equal(f.rawTrack.stopped, true);
  pending.resolve(new Response('v=0\r\n', { status: 201, headers: { Location: 'webrtc?id=late-session' } }));
  await recovering;
  assert.ok(f.requests.some(value => value.method === 'DELETE' && value.url.endsWith('id=late-session')));
  assert.equal(f.timers.timeouts.size, 0);
  assert.equal(f.peers.length, 2);
});

test('failed reconnect attempts back off and stop after the bounded retry limit', async () => {
  let posts = 0;
  const f = recoveryFixture({ fetcher: async (url, options) => {
    if (options.method === 'DELETE') return new Response(null, { status: 200 });
    return ++posts === 1 ? answer() : new Response(null, { status: 503 });
  } });
  await f.publisher.start();
  for (let attempt = 1; attempt <= 7; attempt++) {
    f.timers.clearTimeout(f.publisher.reconnectTimer); f.publisher.reconnectTimer = undefined;
    await f.publisher.reconnect();
    if (attempt <= 6) {
      assert.equal(f.rawTrack.stopped, false);
      assert.equal([...f.timers.timeouts.values()][0].delay, Math.min(15000, 1000 * 2 ** (attempt - 1)));
    }
  }
  assert.equal(posts, 7);
  assert.equal(f.rawTrack.stopped, true);
  assert.equal(f.states.at(-1)[0], 'error');
  assert.equal(f.timers.timeouts.size, 0);
});

test('codec quality hints apply only to H.264 and do not force a minimum bitrate', () => {
  const sdp = 'v=0\r\na=rtpmap:102 H264/90000\r\na=fmtp:102 profile-level-id=42e01f;packetization-mode=1;x-google-min-bitrate=2000\r\na=rtpmap:96 VP8/90000\r\na=fmtp:96 max-fr=30\r\n';
  const tuned = qualitySdp(sdp);
  assert.ok(tuned.includes('profile-level-id=42e01f;packetization-mode=1;x-google-start-bitrate=6000;x-google-max-bitrate=12000'));
  assert.ok(tuned.includes('a=fmtp:96 max-fr=30\r\n'));
  assert.ok(!tuned.includes('min-bitrate'));
  assert.equal(qualitySdp(tuned), tuned);
});

test('reliable media mode removes UDP candidates and retains TCP and security attributes', () => {
  const sdp = 'v=0\r\na=fingerprint:sha-256 test\r\na=candidate:1 1 udp 100 192.168.1.1 8555 typ host\r\na=candidate:2 1 tcp 90 192.168.1.1 8555 typ host tcptype passive\r\n';
  const reliable = transportSdp(sdp, 'tcp');
  assert.ok(!reliable.includes(' udp '));
  assert.ok(reliable.includes('tcptype passive'));
  assert.ok(reliable.includes('fingerprint:sha-256 test'));
  assert.equal(transportSdp(sdp, 'auto'), sdp);
  assert.throws(() => transportSdp('v=0\r\n', 'tcp'), /did not advertise a TCP/);
});

function stats(timestamp, framesEncoded = timestamp * 30 / 1000) {
  return new Map([
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp, framesEncoded,
      bytesSent: timestamp * 750, frameWidth: 1920, frameHeight: 1080, codecId: 'codec', transportId: 'transport', qualityLimitationReason: 'bandwidth' }],
    ['codec', { type: 'codec', mimeType: 'video/H264' }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', remoteCandidateId: 'candidate' }],
    ['candidate', { type: 'remote-candidate', protocol: 'tcp' }],
  ]);
}

test('transmission metrics measure encoded quality and bitrate instead of capture constraints', () => {
  const first = videoStats(stats(1000));
  const next = videoStats(stats(3000), first);
  assert.equal(next.bitrate, 6_000_000);
  assert.equal(next.fps, 30);
  assert.equal(next.width, 1920); assert.equal(next.height, 1080);
  assert.equal(next.protocol, 'tcp'); assert.equal(next.limitation, 'bandwidth');
  assert.equal(first.bitrate, null);
  assert.equal(videoStats(new Map()), null);
});

test('outbound encoding stall triggers recovery and metrics polling stops on Stop', async () => {
  const f = recoveryFixture({ metrics: true }); await f.publisher.start();
  const peer = f.peers[0]; const poll = [...f.timers.intervals.values()][0].fn;
  for (let now = 1000; now <= 11000; now += 2000) { peer.stats = stats(now, 30); await poll(); }
  assert.equal(f.states.at(-1)[0], 'reconnecting');
  assert.ok(f.states.at(-1)[1].includes('stalled'));
  assert.equal([...f.timers.timeouts.values()][0].delay, 0);
  await f.publisher.stop();
  assert.equal(f.timers.intervals.size, 0); assert.equal(f.timers.timeouts.size, 0);
});

test('digital frame watchdog resumes rendering when video frame callbacks stop', async () => {
  const f = capture(); let now = 0;
  f.source.deps.now = () => now;
  f.video.currentTime = 0;
  f.video.requestVideoFrameCallback = () => 9; f.video.cancelVideoFrameCallback = () => {};
  await f.source.start(); await f.source.setZoom(2);
  const initial = f.draws.length;
  now = 500; f.video.currentTime = 1; f.frame();
  assert.equal(f.draws.length, initial + 1);
  f.frame(); assert.equal(f.draws.length, initial + 1);
  f.source.stop(); assert.equal(f.cleared(), true);
});

test('digital zoom requests a higher-resolution source and returns to Full HD at 1x', async () => {
  const f = capture(); let settings = { width: 1920, height: 1080, frameRate: 30 };
  f.rawTrack.getCapabilities = () => ({ width: { max: 3840 }, height: { max: 2160 } });
  f.rawTrack.getSettings = () => settings;
  const constraints = [];
  f.rawTrack.applyConstraints = async value => {
    constraints.push(value);
    settings = { width: value.width.ideal, height: value.height.ideal, frameRate: 30 };
  };
  await f.source.start(); await f.source.setZoom(2);
  assert.equal(constraints[0].width.ideal, 3840);
  assert.equal(constraints[0].height.ideal, 2160);
  assert.equal(f.source.detailedCapture, true);
  assert.equal(f.source.needsScaling, true);
  f.video.videoWidth = 3840; f.video.videoHeight = 2160; f.source.drawFrame();
  assert.deepEqual(f.draws.at(-1).slice(1), [960, 540, 1920, 1080, 0, 0, 1920, 1080]);
  await f.source.setZoom(1);
  assert.equal(constraints[1].width.ideal, 1920);
  assert.equal(f.source.output, f.raw);
  assert.equal(f.source.detailedCapture, false);
  f.source.stop();
});

test('digital zoom center-crops the source while preserving its aspect ratio', () => {
  assert.deepEqual(cropRect(1920, 1080, 1), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(cropRect(1920, 1080, 2), { x: 480, y: 270, width: 960, height: 540 });
  assert.deepEqual(cropRect(1920, 1080, 4), { x: 720, y: 405, width: 480, height: 270 });
  for (const values of [[0, 1, 1], [1, 1, 0], [1, NaN, 1], [1, 1, Infinity]]) {
    assert.throws(() => cropRect(...values), RangeError);
  }
});

test('WHIP session URL resolves the actual relative go2rtc Location', () => {
  assert.equal(whipResource('webrtc?id=abc123', endpoint), 'http://localhost:1984/api/webrtc?id=abc123');
  assert.equal(whipResource('/api/webrtc?id=abc123', endpoint), 'http://localhost:1984/api/webrtc?id=abc123');
});

test('WHIP session URLs reject foreign origins, credentials, paths, missing/duplicate IDs and extra parameters', () => {
  for (const value of [null, 'https://evil.test/api/webrtc?id=x', '//evil.test/api/webrtc?id=x',
    'http://user:pass@localhost:1984/api/webrtc?id=x', '/api/config?id=x',
    'webrtc', 'webrtc?id=', 'webrtc?id=a&id=b', 'webrtc?id=a&dst=camera', 'webrtc?id=a#x']) {
    assert.throws(() => whipResource(value, endpoint));
  }
});

test('camera requests no audio and digital zoom changes the captured canvas frames', async () => {
  const fixture = capture();
  assert.equal(await fixture.source.start(), fixture.raw);
  assert.equal(fixture.constraints().audio, false);
  assert.equal(fixture.source.zoom.mode, 'digital');
  await fixture.source.setZoom(2);
  assert.equal(fixture.source.output, fixture.output);
  fixture.frame();
  assert.deepEqual(fixture.draws.at(-1).slice(1), [480, 270, 960, 540, 0, 0, 1920, 1080]);
  fixture.source.stop();
  assert.ok(fixture.rawTrack.stopped && fixture.outputTrack.stopped && fixture.cleared());
  assert.equal(fixture.video.srcObject, null);
});

test('native zoom and unmodified 1x video bypass canvas rendering', async () => {
  for (const native of [false, true]) {
    const fixture = capture({ native });
    assert.equal(await fixture.source.start(), fixture.raw);
    if (native) await fixture.source.setZoom(2);
    assert.equal(fixture.source.output, fixture.raw);
    assert.equal(fixture.source.video, undefined);
    assert.equal(fixture.source.timer, undefined);
    assert.equal(fixture.draws.length, 0);
    fixture.source.stop();
  }
});

test('digital zoom enlarges smaller input to full output resolution with high-quality interpolation', async () => {
  const fixture = capture({ videoWidth: 640, videoHeight: 480 });
  await fixture.source.start();
  await fixture.source.setZoom(2);
  assert.deepEqual(fixture.draws.at(-1).slice(1), [160, 120, 320, 240, 0, 0, 1440, 1080]);
  assert.equal(fixture.context.imageSmoothingEnabled, true);
  assert.equal(fixture.context.imageSmoothingQuality, 'high');
  await fixture.source.setZoom(1);
  assert.equal(fixture.source.output, fixture.raw);
  assert.equal(fixture.outputTrack.stopped, true);
  assert.equal(fixture.rawTrack.stopped, false);
  assert.equal(fixture.source.video, undefined);
  fixture.source.stop();
});

test('processed video follows new video frames, limits rendering rate, and cancels callbacks on Stop', async () => {
  const fixture = capture();
  let next;
  let sequence = 0;
  let cancelled;
  fixture.video.requestVideoFrameCallback = callback => { next = callback; return ++sequence; };
  fixture.video.cancelVideoFrameCallback = id => { cancelled = id; };
  await fixture.source.start();
  await fixture.source.setZoom(2);
  assert.equal(fixture.source.timer, undefined);
  const initial = fixture.draws.length;
  next(100); next(110); next(134);
  assert.equal(fixture.draws.length, initial + 2);
  fixture.source.stop();
  assert.equal(cancelled, sequence);
  next(200);
  assert.equal(fixture.draws.length, initial + 2);
});

test('older-browser rendering skips duplicate video timestamps but responds immediately to zoom', async () => {
  const fixture = capture();
  fixture.video.currentTime = 0;
  await fixture.source.start();
  await fixture.source.setZoom(2);
  fixture.frame();
  const count = fixture.draws.length;
  fixture.frame();
  assert.equal(fixture.draws.length, count);
  fixture.video.currentTime = 1 / 30;
  fixture.frame();
  assert.equal(fixture.draws.length, count + 1);
  await fixture.source.setZoom(3);
  assert.equal(fixture.draws.length, count + 2);
  fixture.source.stop();
});

test('failed sender replacement preserves the live raw stream and cleans up the rejected zoom renderer', async () => {
  const fixture = capture();
  const { publisher, peer } = publishing(async (url, options) =>
    options.method === 'POST' ? answer() : new Response(null, { status: 200 }), fixture.source);
  await publisher.start();
  peer.replacementFailure = true;
  await assert.rejects(() => fixture.source.setZoom(2), /could not switch zoom video/);
  assert.equal(fixture.source.output, fixture.raw);
  assert.equal(fixture.source.zoom.value, 1);
  assert.equal(fixture.source.video, undefined);
  assert.equal(fixture.outputTrack.stopped, true);
  assert.equal(fixture.rawTrack.stopped, false);
  assert.equal(peer.sentTrack, fixture.rawTrack);
  await publisher.stop();
});

test('Stop during lazy zoom setup releases the raw camera and prevents late replacement', async () => {
  const fixture = capture();
  await fixture.source.start();
  const pending = deferred();
  fixture.video.play = () => pending.promise;
  const zoom = fixture.source.setZoom(2);
  fixture.source.stop();
  pending.resolve();
  await assert.rejects(zoom, CancelledError);
  assert.equal(fixture.source.output, fixture.raw);
  assert.equal(fixture.rawTrack.stopped, true);
  assert.equal(fixture.source.canvasOutput, undefined);
  assert.equal(fixture.video.srcObject, null);
});

test('camera prefers the rear camera and requests up to 1080p/30 without a mandatory aspect ratio', async () => {
  const fixture = capture();
  await fixture.source.start();
  assert.deepEqual(fixture.constraints().video.facingMode, { ideal: 'environment' });
  assert.deepEqual(fixture.constraints().video.width, { ideal: 1920, max: 1920 });
  assert.deepEqual(fixture.constraints().video.height, { ideal: 1080, max: 1920 });
  assert.deepEqual(fixture.constraints().video.frameRate, { ideal: 30, max: 30 });
  assert.equal(fixture.constraints().video.aspectRatio, undefined);
  fixture.source.stop();
});

test('larger camera frames are capped to 1080p with their proportions intact; smaller frames are not upscaled', async () => {
  for (const [width, height, expectedWidth, expectedHeight] of [
    [3840, 2160, 1920, 1080], [2160, 3840, 1080, 1920],
    [2560, 1920, 1440, 1080], [640, 480, 640, 480],
  ]) {
    const fixture = capture({ videoWidth: width, videoHeight: height });
    await fixture.source.start();
    if (width === expectedWidth && height === expectedHeight) {
      assert.equal(fixture.source.output, fixture.raw);
      assert.equal(fixture.source.video, undefined);
    } else {
      assert.equal(fixture.canvas.width, expectedWidth);
      assert.equal(fixture.canvas.height, expectedHeight);
      assert.equal(fixture.canvas.width / fixture.canvas.height, width / height);
    }
    fixture.source.stop();
  }
});

test('portrait output follows decoded video dimensions even when track settings are landscape', async () => {
  const fixture = capture({ videoWidth: 720, videoHeight: 1280, trackWidth: 1280, trackHeight: 720 });
  await fixture.source.start();
  await fixture.source.setZoom(2);
  assert.equal(fixture.canvas.width, 1080);
  assert.equal(fixture.canvas.height, 1920);
  fixture.frame();
  assert.deepEqual(fixture.draws.at(-1).slice(1), [180, 320, 360, 640, 0, 0, 1080, 1920]);
  fixture.source.stop();
});

test('camera rotation resizes the outgoing canvas without restarting or changing zoom', async () => {
  const fixture = capture();
  await fixture.source.start();
  await fixture.source.setZoom(2);
  fixture.video.videoWidth = 1080;
  fixture.video.videoHeight = 1920;
  fixture.frame();
  assert.deepEqual(fixture.draws.at(-1).slice(1), [270, 480, 540, 960, 0, 0, 1080, 1920]);
  assert.equal(fixture.canvas.width, 1080);
  assert.equal(fixture.canvas.height, 1920);
  assert.equal(fixture.source.output, fixture.output);
  fixture.source.stop();
});

test('native zoom honors supported range and reads the applied camera setting', async () => {
  const { source, rawTrack } = capture({ native: true });
  await source.start();
  assert.deepEqual(source.zoom, { mode: 'native', min: 1, max: 5, step: 0.25, value: 1 });
  await source.setZoom(2.5);
  assert.equal(rawTrack.getSettings().zoom, 2.5);
  assert.equal(source.digitalZoom, 1);
  await assert.rejects(() => source.setZoom(6), RangeError);
  source.stop();
});

test('continuous autofocus and exposure are enabled and confirmed on the raw camera', async () => {
  const fixture = capture({ automatic: true });
  await fixture.source.start();
  assert.deepEqual(fixture.source.automatic, { focusMode: 'continuous', exposureMode: 'continuous' });
  assert.deepEqual(fixture.modes, { focusMode: 'continuous', exposureMode: 'continuous' });
  assert.deepEqual(fixture.rawTrack.getConstraints().width, { ideal: 1920, max: 1920 });
  assert.deepEqual(fixture.rawTrack.getConstraints().frameRate, { ideal: 30, max: 30 });
  fixture.source.stop();
});

test('rejected autofocus does not prevent automatic exposure or camera capture', async () => {
  const fixture = capture({ automatic: true });
  const apply = fixture.rawTrack.applyConstraints.bind(fixture.rawTrack);
  fixture.rawTrack.applyConstraints = async constraints => {
    if (constraints.advanced.some(entry => entry.focusMode)) throw new Error('Focus rejected');
    await apply(constraints);
  };
  await fixture.source.start();
  assert.equal(fixture.source.automatic.focusMode, 'failed');
  assert.equal(fixture.source.automatic.exposureMode, 'continuous');
  assert.equal(fixture.source.output, fixture.raw);
  fixture.source.stop();
});

test('silently ignored automatic controls are reported as unconfirmed', async () => {
  const fixture = capture({ automatic: true });
  fixture.rawTrack.applyConstraints = async () => {};
  await fixture.source.start();
  assert.deepEqual(fixture.source.automatic, { focusMode: 'unconfirmed', exposureMode: 'unconfirmed' });
  fixture.source.stop();
});

test('a control resetting another control is not falsely reported as confirmed', async () => {
  const fixture = capture({ automatic: true });
  const apply = fixture.rawTrack.applyConstraints.bind(fixture.rawTrack);
  fixture.rawTrack.applyConstraints = async constraints => {
    await apply(constraints);
    if (constraints.advanced.at(-1).exposureMode) fixture.modes.focusMode = 'manual';
  };
  await fixture.source.start();
  assert.equal(fixture.source.automatic.focusMode, 'unconfirmed');
  assert.equal(fixture.source.automatic.exposureMode, 'continuous');
  fixture.source.stop();
});

test('missing camera control APIs and fixed-focus modes retain capture without claiming continuous focus', async () => {
  const managed = capture();
  await managed.source.start();
  assert.deepEqual(managed.source.automatic, { focusMode: 'camera-managed', exposureMode: 'camera-managed' });
  managed.source.stop();
  const fixed = capture();
  fixed.rawTrack.getCapabilities = () => ({ focusMode: ['none'], exposureMode: ['manual'] });
  await fixed.source.start();
  assert.deepEqual(fixed.source.automatic, { focusMode: 'unavailable', exposureMode: 'unavailable' });
  fixed.source.stop();
});

test('native zoom preserves 1080p/30 and restores continuous modes if the driver resets them', async () => {
  const fixture = capture({ native: true, automatic: true });
  await fixture.source.start();
  const apply = fixture.rawTrack.applyConstraints.bind(fixture.rawTrack);
  fixture.rawTrack.applyConstraints = async constraints => {
    await apply(constraints);
    if (typeof constraints.advanced.at(-1).zoom === 'number') {
      fixture.modes.focusMode = 'manual'; fixture.modes.exposureMode = 'manual';
    }
  };
  await fixture.source.setZoom(2.5);
  assert.equal(fixture.rawTrack.getSettings().zoom, 2.5);
  assert.deepEqual(fixture.modes, { focusMode: 'continuous', exposureMode: 'continuous' });
  assert.deepEqual(fixture.rawTrack.getConstraints().width, { ideal: 1920, max: 1920 });
  assert.deepEqual(fixture.rawTrack.getConstraints().frameRate, { ideal: 30, max: 30 });
  fixture.source.stop();
});

test('cancellation during autofocus startup releases camera and stops applying controls', async () => {
  const fixture = capture({ automatic: true });
  const pending = deferred();
  const entered = deferred();
  let calls = 0;
  fixture.rawTrack.applyConstraints = async () => { calls++; entered.resolve(); await pending.promise; };
  const start = fixture.source.start();
  await entered.promise;
  fixture.source.stop();
  pending.resolve();
  await assert.rejects(start, CancelledError);
  assert.equal(calls, 1);
  assert.equal(fixture.rawTrack.stopped, true);
});

test('Chromium mixed-constraint rejection retries image controls while retaining capture quality', async () => {
  const fixture = capture({ native: true, automatic: true });
  const apply = fixture.rawTrack.applyConstraints.bind(fixture.rawTrack);
  const imageRequests = [];
  fixture.rawTrack.applyConstraints = async constraints => {
    if (constraints.width || constraints.frameRate) {
      const error = new Error('Mixing ImageCapture and non-ImageCapture constraints is not currently supported');
      error.name = 'OverconstrainedError'; throw error;
    }
    imageRequests.push(constraints);
    // Chromium retains its core capture constraints when applying image-only controls.
    const previous = fixture.rawTrack.getConstraints();
    await apply({ ...previous, ...constraints });
  };
  await fixture.source.start();
  await fixture.source.setZoom(2.5);
  assert.deepEqual(fixture.source.automatic, { focusMode: 'continuous', exposureMode: 'continuous' });
  assert.equal(fixture.source.zoom.mode, 'native');
  assert.equal(fixture.rawTrack.getSettings().zoom, 2.5);
  assert.equal(imageRequests.length, 3);
  for (const request of imageRequests) {
    assert.equal(request.width, undefined); assert.equal(request.frameRate, undefined);
  }
  assert.deepEqual(fixture.rawTrack.getConstraints().width, { ideal: 1920, max: 1920 });
  assert.deepEqual(fixture.rawTrack.getConstraints().frameRate, { ideal: 30, max: 30 });
  fixture.source.stop();
});

test('camera constraint failure switches to outgoing digital zoom', async () => {
  const fixture = capture({ native: true });
  await fixture.source.start();
  fixture.rawTrack.applyConstraints = async () => { throw new Error('Unsupported constraint'); };
  await fixture.source.setZoom(3);
  assert.equal(fixture.source.zoom.mode, 'digital');
  fixture.frame();
  assert.equal(fixture.draws.at(-1)[3], 640);
  fixture.source.stop();
});

test('silent camera constraint failure also falls back to digital zoom', async () => {
  const fixture = capture({ native: true });
  await fixture.source.start();
  fixture.rawTrack.applyConstraints = async () => {};
  await fixture.source.setZoom(2);
  assert.equal(fixture.source.zoom.mode, 'digital');
  fixture.source.stop();
});

test('unsupported zoom is explicitly unavailable, while native zoom works without canvas capture', async () => {
  const unsupported = capture({ canvas: false });
  assert.equal(await unsupported.source.start(), unsupported.raw);
  assert.equal(unsupported.source.zoom.mode, 'unavailable');
  unsupported.source.stop();
  const native = capture({ canvas: false, native: true });
  await native.source.start();
  await native.source.setZoom(2);
  assert.equal(native.source.zoom.mode, 'native');
  native.source.stop();
});

test('late camera permission after Stop releases the newly returned camera immediately', async () => {
  const permission = deferred();
  const fixture = capture({ permission: permission.promise });
  const startup = fixture.source.start();
  fixture.source.stop();
  permission.resolve(fixture.raw);
  await assert.rejects(startup, CancelledError);
  assert.ok(fixture.rawTrack.stopped);
});

test('failed preview startup releases the raw camera', async () => {
  const fixture = capture({ playFailure: true, videoWidth: 3840, videoHeight: 2160 });
  await assert.rejects(() => fixture.source.start(), /Video playback failed/);
  assert.ok(fixture.rawTrack.stopped);
});

test('publisher sends the outgoing track send-only and deletes its WHIP session on Stop', async () => {
  const requests = [];
  const fixture = capture();
  const { publisher, peer, previews } = publishing(async (url, options) => {
    requests.push({ url, options });
    return options.method === 'POST' ? answer() : new Response(null, { status: 200 });
  }, fixture.source);
  await publisher.start();
  assert.equal(peer.sentTrack, fixture.rawTrack);
  assert.equal(peer.direction, 'sendonly');
  assert.deepEqual(peer.encodings, [{ maxBitrate: 12_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 }]);
  assert.equal(peer.parameters.degradationPreference, 'maintain-resolution');
  assert.equal(previews[0], fixture.raw);
  assert.equal(peer.answer.type, 'answer');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/sdp');
  await fixture.source.setZoom(2);
  assert.equal(peer.sentTrack, fixture.outputTrack);
  assert.equal(previews.at(-1), fixture.output);
  await fixture.source.setZoom(1);
  assert.equal(peer.sentTrack, fixture.rawTrack);
  assert.equal(previews.at(-1), fixture.raw);
  await publisher.stop();
  await publisher.stop();
  assert.ok(peer.closed && fixture.rawTrack.stopped);
  assert.equal(requests.filter(r => r.options.method === 'DELETE').length, 1);
  assert.equal(requests[1].url, 'http://localhost:1984/api/webrtc?id=abc123');
  assert.equal(previews.at(-1), null);
});

test('unsupported sender quality tuning does not prevent publishing or cleanup', async () => {
  const fixture = capture();
  const { publisher, peer } = publishing(async (url, options) =>
    options.method === 'POST' ? answer() : new Response(null, { status: 200 }), fixture.source);
  peer.encodingFailure = true;
  await publisher.start();
  assert.equal(peer.answer.type, 'answer');
  await publisher.stop();
  assert.ok(peer.closed && fixture.rawTrack.stopped);
});

test('H.264 publishing retains offered retransmission/FEC codecs and excludes unsupported primary codecs', async () => {
  const previous = globalThis.RTCRtpSender;
  const offered = ['video/VP8', 'video/H264', 'video/rtx', 'video/red', 'video/ulpfec'].map(mimeType => ({ mimeType }));
  globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs: offered }) };
  try {
    const { publisher, peer } = publishing(async (url, options) =>
      options.method === 'POST' ? answer() : new Response(null, { status: 200 }));
    await publisher.start();
    assert.deepEqual(peer.codecPreferences.map(codec => codec.mimeType), ['video/H264', 'video/rtx', 'video/red', 'video/ulpfec']);
    await publisher.stop();
  } finally {
    if (previous === undefined) delete globalThis.RTCRtpSender;
    else globalThis.RTCRtpSender = previous;
  }
});

test('HTTP failure closes peer and all camera resources', async () => {
  const fixture = capture();
  const { publisher, peer } = publishing(async () => new Response(null, { status: 404 }), fixture.source);
  await assert.rejects(() => publisher.start(), /HTTP 404/);
  assert.ok(peer.closed && fixture.rawTrack.stopped);
  assert.equal(fixture.source.video, undefined);
});

test('malformed SDP after session creation still deletes the upstream resource', async () => {
  const methods = [];
  const { publisher } = publishing(async (url, options) => {
    methods.push(options.method);
    return options.method === 'POST'
      ? new Response('invalid', { status: 201, headers: { Location: 'webrtc?id=abc123' } })
      : new Response(null, { status: 200 });
  });
  await assert.rejects(() => publisher.start(), /invalid SDP/);
  assert.deepEqual(methods, ['POST', 'DELETE']);
});

test('an SDP answer rejecting video reports codec incompatibility and cleans up immediately', async () => {
  const methods = [];
  const { publisher, peer } = publishing(async (url, options) => {
    methods.push(options.method);
    return options.method === 'POST'
      ? new Response('v=0\r\nm=video 0 UDP/TLS/RTP/SAVPF 0\r\n', { status: 201, headers: { Location: 'webrtc?id=abc123' } })
      : new Response(null, { status: 200 });
  });
  await assert.rejects(() => publisher.start(), /rejected the video codec/);
  assert.ok(peer.closed);
  assert.deepEqual(methods, ['POST', 'DELETE']);
});

test('Stop during SDP POST closes the camera and deletes a late upstream resource', async () => {
  const pending = deferred();
  const posted = deferred();
  const requests = [];
  const { publisher, peer, source } = publishing(async (url, options) => {
    requests.push(options.method);
    if (options.method === 'POST') { posted.resolve(); return pending.promise; }
    return new Response(null, { status: 200 });
  });
  const startup = publisher.start();
  await posted.promise;
  await publisher.stop();
  assert.ok(peer.closed && source.closed);
  pending.resolve(answer());
  await assert.rejects(startup, CancelledError);
  assert.deepEqual(requests, ['POST', 'DELETE']);
  assert.equal(peer.answer, undefined);
});

test('failed DELETE can be retried; missing resources count as already cleaned up', async () => {
  let deletions = 0;
  const { publisher } = publishing(async (url, options) => {
    if (options.method === 'POST') return answer();
    return new Response(null, { status: ++deletions === 1 ? 500 : 404 });
  });
  await publisher.start();
  await publisher.stop(true);
  assert.ok(publisher.resource);
  await publisher.stop();
  assert.equal(publisher.resource, null);
});

test('cancelled ICE gathering rejects promptly without waiting for its timeout', async () => {
  const peer = new Peer();
  peer.iceGatheringState = 'gathering';
  const controller = new AbortController();
  const waiting = waitForIce(peer, controller.signal);
  controller.abort();
  await assert.rejects(waiting, CancelledError);
});

test('camera permission failures provide actionable messages', () => {
  assert.match(cameraError({ name: 'NotAllowedError' }), /Allow camera access/);
  assert.match(cameraError({ name: 'NotFoundError' }), /Connect a camera/);
  assert.match(cameraError({ name: 'NotReadableError' }), /Close other camera apps/);
});
