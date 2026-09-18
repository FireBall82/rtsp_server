// Real browser encoder/decoder and recovery with local signaling, no physical camera.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: process.env.CAMERA_ALLOW_UNTRUSTED_TLS === '1' });
  await page.goto(process.env.CAMERA_URL || 'http://localhost:1984/');
  await page.evaluate(async () => {
    // Test VP8 encoder where the cached browser lacks H.264; never sent to go2rtc.
    Object.defineProperty(RTCRtpSender, 'getCapabilities', { value: undefined });
    const { CameraSource, Publisher } = await import('/media.mjs');
    const input = document.createElement('canvas'); input.width = 1920; input.height = 1080;
    let frame = 0;
    const draw = () => {
      const c = input.getContext('2d');
      c.fillStyle = 'black'; c.fillRect(0, 0, input.width, input.height);
      c.fillStyle = frame++ % 2 ? 'white' : 'red'; c.fillRect(400, 200, 1000, 650);
    };
    draw(); window.inputTimer = setInterval(draw, 1000 / 30);
    const raw = input.captureStream(30);
    let captured = 0;
    const source = new CameraSource({ getUserMedia: async () => { captured++; return raw; },
      createVideo: () => {
        const video = document.createElement('video');
        // Simulate the mobile callback stall; watchdog must keep encoding live.
        video.requestVideoFrameCallback = () => 123;
        video.cancelVideoFrameCallback = () => {};
        return video;
      } });
    window.receivers = []; window.posts = 0; window.deletes = 0;
    const decoded = document.createElement('video'); decoded.muted = true; decoded.autoplay = true;
    decoded.playsInline = true; decoded.style.cssText = 'width:320px;height:180px';
    document.body.append(decoded); window.decoded = decoded;
    window.publisher = new Publisher({ endpoint: new URL('/api/webrtc?dst=test', location.href).href, source,
      onMetrics: value => { window.metrics = value; },
      fetcher: async (url, options) => {
        if (options.method === 'DELETE') { window.deletes++; return new Response(null, { status: 200 }); }
        const receiver = new RTCPeerConnection(); window.receivers.push(receiver); window.posts++;
        receiver.ontrack = event => { decoded.srcObject = event.streams[0]; void decoded.play(); };
        await receiver.setRemoteDescription({ type: 'offer', sdp: options.body });
        await receiver.setLocalDescription(await receiver.createAnswer());
        if (receiver.iceGatheringState !== 'complete') await new Promise(resolve => receiver.addEventListener('icegatheringstatechange', () => {
          if (receiver.iceGatheringState === 'complete') resolve();
        }));
        return new Response(receiver.localDescription.sdp, { status: 201, headers: { Location: `webrtc?id=test${window.posts}` } });
      } });
    window.captureCount = () => captured;
    await window.publisher.start();
  });
  await page.waitForFunction(() => window.metrics?.fps > 10 && window.decoded.videoWidth === 1920, null, { timeout: 20000 })
    .catch(async error => {
      console.error(await page.evaluate(async () => ({ metrics: window.metrics,
        state: window.publisher.pc.connectionState, width: window.decoded.videoWidth,
        settings: window.publisher.source.track.getSettings(),
        stats: [...(await window.publisher.pc.getStats()).values()].filter(stat => ['outbound-rtp','remote-inbound-rtp'].includes(stat.type)) })));
      throw error;
    });
  async function progress() {
    const before = await page.evaluate(() => window.decoded.getVideoPlaybackQuality().totalVideoFrames);
    await page.waitForFunction(before => window.decoded.getVideoPlaybackQuality().totalVideoFrames >= before + 40,
      before, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.metrics.width), 1920);
    assert.equal(await page.evaluate(() => window.metrics.height), 1080);
  }
  await progress();
  await page.evaluate(() => window.publisher.source.setZoom(2));
  await progress();
  assert.equal(await page.evaluate(() => window.publisher.source.context.imageSmoothingQuality), 'high');
  // A real closed peer forces WHIP reconstruction and uses the existing camera.
  await page.evaluate(() => window.publisher.pc.close());
  await page.waitForFunction(() => window.posts === 2 && window.publisher.pc.connectionState === 'connected', null, { timeout: 20000 });
  await progress();
  assert.equal(await page.evaluate(() => window.captureCount()), 1);
  assert.equal(await page.evaluate(() => window.publisher.source.zoom.value), 2);
  assert.equal(await page.evaluate(() => window.deletes), 1);
  await page.evaluate(() => window.publisher.source.setZoom(1));
  await progress();
  await page.evaluate(async () => {
    await window.publisher.stop(); clearInterval(window.inputTimer);
    for (const receiver of window.receivers) receiver.close();
  });
  assert.equal(await page.evaluate(() => window.publisher.source.track.readyState), 'ended');
  assert.equal(await page.evaluate(() => window.publisher.metricsTimer === undefined && window.publisher.reconnectTimer === undefined), true);
  console.log('Browser transmission passed: actual 1080p encoded/decoded frame progress, digital upscale with stalled callbacks, automatic peer recovery, camera retained once, zoom retained, return to 1x and Stop cleanup. Test codec is VP8; H.264 bridge is checked separately.');
} finally { await browser.close(); }
