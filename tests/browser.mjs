// Run against a local go2rtc instance. Uses a synthetic camera, never real hardware.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.CAMERA_URL || 'http://localhost:1984/';
const rtsp = process.env.CAMERA_RTSP || 'rtsp://127.0.0.1:8554/camera';
const tlsOptions = { ignoreHTTPSErrors: process.env.CAMERA_ALLOW_UNTRUSTED_TLS === '1' };
const temporary = await mkdtemp(join(tmpdir(), 'camera-browser-'));
const chart = join(temporary, 'camera.y4m');
await mkdir('test-results', { recursive: true });
await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'smptebars=size=1920x1080:rate=30', '-frames:v', '1', '-pix_fmt', 'yuv420p', chart]);

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${chart}`],
});
try {
  const context = await browser.newContext({ ...tlsOptions, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto(base);
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => document.querySelector('#rtsp').value.includes('/camera'));
  assert.equal(await page.locator('#stop').isDisabled(), true);
  assert.equal(await page.evaluate(() => document.querySelector('#preview').srcObject), null);
  await page.screenshot({ path: 'test-results/standby.png', fullPage: true });

  for (const path of ['api/config', 'api/streams', 'api/exit', 'api/restart', 'api/ffmpeg']) {
    const blocked = await context.request.get(new URL(path, base).href);
    assert.equal(blocked.status(), 404, `management route ${path} must be disabled`);
  }
  const h264 = await page.evaluate(() => RTCRtpSender.getCapabilities('video').codecs.some(codec => codec.mimeType.toLowerCase() === 'video/h264'));
  if (h264) {
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Streaming', null, { timeout: 30000 }).catch(async error => {
    console.error('Camera state:', await page.locator('#status').textContent(), await page.locator('#message').textContent());
    console.error('Page errors:', errors);
    await page.screenshot({ path: 'test-results/error.png', fullPage: true });
    throw error;
  });
  assert.match(await page.locator('#zoom-mode').textContent(), /Digital zoom/);
  const originalTracks = await page.evaluate(() => {
    window.testOutputTracks = document.querySelector('#preview').srcObject.getTracks();
    return window.testOutputTracks.map(track => ({ kind: track.kind, readyState: track.readyState }));
  });
  assert.deepEqual(originalTracks, [{ kind: 'video', readyState: 'live' }]);
  await page.waitForFunction(() => document.querySelector('#preview').videoWidth === 1920 && document.querySelector('#preview').videoHeight === 1080);

  async function frame() {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport',
      'tcp', '-i', rtsp, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo',
      '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(stdout.length, 64 * 36 * 3, 'RTSP must deliver a decodable video frame');
    return stdout;
  }
  const before = await frame();
  await page.locator('#zoom').fill('2');
  await page.waitForFunction(() => document.querySelector('#zoom-value').textContent === '2.0×');
  const after = await frame();
  const position = (10 * 64 + 2) * 3;
  const pixelDifference = [0, 1, 2].reduce((sum, offset) => sum + Math.abs(before[position + offset] - after[position + offset]), 0);
  assert.ok(pixelDifference > 60, `2x zoom must change the decoded RTSP image (difference ${pixelDifference})`);
  await page.screenshot({ path: 'test-results/streaming.png', fullPage: true });
  await page.locator('#stop').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Ready');

  } else {
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#message').textContent.includes('cannot encode H.264'));
    assert.equal(await page.evaluate(() => document.querySelector('#preview').srcObject), null);
    assert.equal(await page.locator('#stop').isDisabled(), true);

    // Exercise the real outgoing canvas track even when this browser cannot encode H.264.
    await page.evaluate(async () => {
      const { CameraSource } = await import('/media.mjs');
      window.testSource = new CameraSource();
      window.testSource.onOutput = async stream => {
        const preview = document.querySelector('#preview');
        preview.srcObject = stream;
        window.testOutputTracks = stream.getTracks();
        await preview.play();
      };
      const output = await window.testSource.start();
      const preview = document.querySelector('#preview');
      preview.srcObject = output;
      preview.style.display = 'block';
      document.querySelector('#placeholder').style.display = 'none';
      window.testOutputTracks = output.getTracks();
      await preview.play();
      window.samplePixel = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 36;
        const context = canvas.getContext('2d');
        context.drawImage(preview, 0, 0, 64, 36);
        return [...context.getImageData(2, 10, 1, 1).data].slice(0, 3);
      };
    });
    await page.waitForFunction(() => document.querySelector('#preview').videoWidth > 0);
    assert.deepEqual(await page.evaluate(() => {
      const video = document.querySelector('#preview');
      return { width: video.videoWidth, height: video.videoHeight, frameRate: window.testSource.track.getSettings().frameRate };
    }), { width: 1920, height: 1080, frameRate: 30 });
    const before = await page.evaluate(() => window.samplePixel());
    await page.evaluate(() => window.testSource.setZoom(2));
    await page.waitForFunction(before => window.samplePixel().reduce((sum, value, i) => sum + Math.abs(value - before[i]), 0) > 60, before);
    await page.screenshot({ path: 'test-results/digital-capture.png', fullPage: true });
    await page.evaluate(() => {
      window.testSource.stop();
      document.querySelector('#preview').srcObject = null;
      document.querySelector('#preview').style.display = 'none';
      document.querySelector('#placeholder').style.display = 'flex';
    });
    assert.deepEqual(await page.evaluate(() => window.testOutputTracks.map(track => track.readyState)), ['ended']);
    console.log('Browser has no H.264 encoder: compatibility error and real canvas capture/2x zoom verified; browser-to-RTSP portion skipped.');
  }
  assert.equal(await page.evaluate(() => document.querySelector('#preview').srcObject), null);
  assert.deepEqual(await page.evaluate(() => window.testOutputTracks.map(track => track.readyState)), ['ended']);

  // Restart proves the first session was torn down successfully.
  if (h264) {
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'Streaming', null, { timeout: 30000 });
    await page.locator('#stop').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'Ready');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();

  // Real synthetic camera and real WebRTC offer; hold signaling to inspect auto-mode UI.
  // This does not publish a VP8 stream into go2rtc or claim physical optical behavior.
  const autoContext = await browser.newContext(tlsOptions);
  await autoContext.addInitScript(() => {
    Object.defineProperty(RTCRtpSender, 'getCapabilities', { value: undefined });
    const OriginalPeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends OriginalPeer {
      constructor(...args) { super(...args); window.autoTestPeer = this; }
    };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async constraints => {
      const raw = await original(constraints);
      const track = raw.getVideoTracks()[0];
      window.autoTestTrack = track;
      const originalCapabilities = track.getCapabilities.bind(track);
      track.getCapabilities = () => { const value = originalCapabilities(); delete value.zoom; return value; };
      const capabilities = track.getCapabilities();
      for (const mode of ['focusMode', 'exposureMode']) {
        if (capabilities[mode]?.includes('continuous') && capabilities[mode]?.includes('manual')) {
          await track.applyConstraints({ advanced: [{ [mode]: 'manual' }] });
        }
      }
      return raw;
    } });
  });
  let releasePost;
  const heldPost = new Promise(resolve => { releasePost = resolve; });
  let cleaned;
  const cleanup = new Promise(resolve => { cleaned = resolve; });
  await autoContext.route('**/api/webrtc?*', async route => {
    if (route.request().method() === 'POST') {
      await heldPost;
      await route.fulfill({ status: 201, contentType: 'application/sdp',
        headers: { Location: 'webrtc?id=auto-test' }, body: 'v=0\r\n' });
    } else {
      await route.fulfill({ status: 200, body: '' });
      cleaned();
    }
  });
  const autoPage = await autoContext.newPage();
  await autoPage.goto(base);
  await autoPage.waitForFunction(() => document.querySelector('#rtsp').value.includes('/camera'));
  await autoPage.locator('#start').click();
  await autoPage.waitForFunction(() => document.querySelector('#status').textContent === 'Connecting');
  const autoResult = await autoPage.evaluate(() => ({
    settings: window.autoTestTrack.getSettings(),
    capabilities: window.autoTestTrack.getCapabilities(),
    status: document.querySelector('#camera-auto').textContent,
  }));
  for (const [mode, label] of [['focusMode', 'Autofocus'], ['exposureMode', 'Auto exposure']]) {
    const confirmed = new RegExp(`${label}: continuous(?: ·|$)`).test(autoResult.status);
    assert.equal(confirmed, autoResult.settings[mode] === 'continuous', autoResult.status);
    if (autoResult.capabilities[mode]?.includes('continuous')) {
      assert.equal(autoResult.settings[mode], 'continuous', `Synthetic ${mode} should be set to continuous`);
    }
  }
  assert.equal(autoResult.settings.frameRate, 30);
  assert.equal(autoResult.settings.width, 1920);
  assert.equal(autoResult.settings.height, 1080);
  await autoPage.locator('#zoom').fill('2');
  await autoPage.waitForFunction(() => document.querySelector('#zoom-value').textContent === '2.0×' &&
    window.autoTestPeer.getSenders()[0].track !== window.autoTestTrack);
  assert.equal(await autoPage.evaluate(() => {
    window.autoTestZoomTrack = window.autoTestPeer.getSenders()[0].track;
    return window.autoTestZoomTrack === document.querySelector('#preview').srcObject.getVideoTracks()[0];
  }), true, 'The preview and real WebRTC sender must use the enlarged track');
  await autoPage.locator('#zoom').fill('1');
  await autoPage.waitForFunction(() => document.querySelector('#zoom-value').textContent === '1.0×' &&
    window.autoTestPeer.getSenders()[0].track === window.autoTestTrack);
  assert.equal(await autoPage.evaluate(() => window.autoTestZoomTrack.readyState), 'ended');
  await autoPage.locator('#stop').click();
  await autoPage.waitForFunction(() => document.querySelector('#status').textContent === 'Ready');
  assert.equal(await autoPage.evaluate(() => window.autoTestTrack.readyState), 'ended');
  releasePost();
  await Promise.race([cleanup, new Promise((_, reject) => setTimeout(() => reject(new Error('Late auto-test signaling cleanup timed out')), 5000))]);
  await autoContext.close();
  console.log('Automatic camera mode browser check passed:', autoResult.status);

  const deniedContext = await browser.newContext(tlsOptions);
  await deniedContext.addInitScript(() => {
    // Permit reaching camera acquisition in builds without H.264 to test permission handling.
    Object.defineProperty(RTCRtpSender, 'getCapabilities', { value: undefined });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
    });
  });
  const denied = await deniedContext.newPage();
  await denied.goto(base);
  await denied.waitForFunction(() => document.querySelector('#rtsp').value.includes('/camera'));
  await denied.locator('#start').click();
  await denied.waitForFunction(() => document.querySelector('#message').textContent.includes('permission was denied'));
  assert.equal(await denied.locator('#start').isDisabled(), false);
  assert.equal(await denied.locator('#stop').isDisabled(), true);
  await deniedContext.close();
  console.log(`Browser checks passed: ${h264 ? 'H.264 RTSP decoding, transmitted 2x zoom, Stop/restart, ' : ''}blocked management APIs, mobile layout and denied permission.`);
} finally {
  await browser.close();
}
