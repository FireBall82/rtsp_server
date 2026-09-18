// Synthetic portrait/landscape video; never opens a physical camera.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', ...(process.env.TEST_BICUBIC === '1' ? ['--enable-unsafe-swiftshader'] : [])],
});
try {
  // Explicit test-only override for a local CA not installed in this test browser.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    ignoreHTTPSErrors: process.env.CAMERA_ALLOW_UNTRUSTED_TLS === '1' });
  const page = await context.newPage();
  if (process.env.TEST_BICUBIC === '1') await page.addInitScript(() => {
    // Exercise the Firefox compatibility path in our cached Chromium build.
    delete CanvasRenderingContext2D.prototype.imageSmoothingQuality;
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.CAMERA_URL || 'http://localhost:1984/');
  await page.waitForFunction(() => document.querySelector('#rtsp').value.includes('/camera'));
  await page.evaluate(async () => {
    const { CameraSource } = await import('/media.mjs');
    const input = document.createElement('canvas');
    input.width = 1080; input.height = 1920;
    const draw = () => {
      const context = input.getContext('2d');
      context.fillStyle = 'black'; context.fillRect(0, 0, input.width, input.height);
      context.fillStyle = 'white'; context.beginPath();
      context.arc(input.width / 2, input.height / 2, 100, 0, Math.PI * 2); context.fill();
      // Asymmetric color marker detects flipped GPU/video texture coordinates.
      context.fillStyle = 'blue';
      context.fillRect(input.width * 0.35 - 6, input.height * 0.35 - 6, 12, 12);
    };
    draw();
    const raw = input.captureStream(30);
    window.cameraInput = input;
    window.cameraInputTimer = setInterval(draw, 1000 / 30);
    window.cameraSource = new CameraSource({ getUserMedia: async constraints => {
      window.cameraConstraints = constraints;
      return raw;
    } });
    window.cameraSource.onOutput = async stream => {
      const preview = document.querySelector('#preview');
      preview.srcObject = stream;
      await preview.play();
    };
    const output = await window.cameraSource.start();
    const preview = document.querySelector('#preview');
    preview.srcObject = output; preview.style.display = 'block';
    document.querySelector('#placeholder').style.display = 'none';
    await preview.play();
  });

  async function check(width, height) {
    await page.waitForFunction(({ width, height }) => {
      const video = document.querySelector('#preview');
      return video.videoWidth === width && video.videoHeight === height &&
        document.querySelector('.preview-label').textContent.includes(`${width} × ${height}`);
    }, { width, height });
    // Resizing the source canvas clears it before the next painted frame. Metadata
    // can arrive first; wait for image content before measuring its proportions.
    await page.waitForFunction(() => {
      const video = document.querySelector('#preview');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0);
      const row = context.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
      let bright = 0;
      for (let i = 0; i < row.length; i += 4) if (row[i] > 200) bright++;
      return bright > 150;
    });
    const result = await page.evaluate(() => {
      const monitor = document.querySelector('.monitor').getBoundingClientRect();
      const video = document.querySelector('#preview');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0);
      const centerX = Math.floor(canvas.width / 2), centerY = Math.floor(canvas.height / 2);
      const row = context.getImageData(0, centerY, canvas.width, 1).data;
      const column = context.getImageData(centerX, 0, 1, canvas.height).data;
      const bright = pixels => {
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 200) count++;
        return count;
      };
      return { aspect: monitor.width / monitor.height, horizontal: bright(row), vertical: bright(column),
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.ok(Math.abs(result.aspect - width / height) < 0.002, JSON.stringify(result));
    assert.ok(result.horizontal > 150, 'The outgoing canvas must contain the circular test image');
    assert.ok(Math.abs(result.horizontal - result.vertical) <= 2, 'A circle must remain circular in the outgoing video');
    assert.equal(result.overflow, false);
  }

  await check(1080, 1920);
  assert.deepEqual(await page.evaluate(() => window.cameraConstraints.video.facingMode), { ideal: 'environment' });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/portrait-camera.png', fullPage: true });
  await page.evaluate(() => window.cameraSource.setZoom(2));
  await page.waitForTimeout(150);
  await check(1080, 1920);
  await page.evaluate(() => { window.cameraInput.width = 1920; window.cameraInput.height = 1080; });
  await check(1920, 1080);
  await page.setViewportSize({ width: 1280, height: 900 });
  await check(1920, 1080);
  await page.screenshot({ path: 'test-results/landscape-camera.png', fullPage: true });
  await page.evaluate(() => window.cameraSource.setZoom(1));
  await page.evaluate(() => { window.cameraInput.width = 640; window.cameraInput.height = 480; });
  await check(640, 480);
  await page.evaluate(() => window.cameraSource.setZoom(2));
  await check(1440, 1080);
  if (process.env.TEST_BICUBIC !== '1') assert.equal(await page.evaluate(() => window.cameraSource.context.imageSmoothingQuality), 'high');
  if (process.env.TEST_BICUBIC === '1') assert.equal(await page.evaluate(() => window.cameraSource.interpolation), 'bicubic');
  const marker = await page.evaluate(() => {
    const video = document.querySelector('#preview'), canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
    return [...context.getImageData(Math.floor(canvas.width * 0.2), Math.floor(canvas.height * 0.2), 1, 1).data];
  });
  assert.ok(marker[2] > 200 && marker[0] < 25, 'Upscaling must preserve the top-left blue marker and orientation');
  await page.evaluate(() => { window.enlargedTrack = window.cameraSource.output.getVideoTracks()[0]; });
  await page.evaluate(() => window.cameraSource.setZoom(1));
  await check(640, 480);
  assert.equal(await page.evaluate(() => window.enlargedTrack.readyState), 'ended');
  assert.equal(await page.evaluate(() => window.cameraSource.video === undefined), true);
  await page.evaluate(() => { window.cameraSource.stop(); clearInterval(window.cameraInputTimer); });
  assert.equal(await page.evaluate(() => window.cameraSource.output.getTracks().every(track => track.readyState === 'ended')), true);
  assert.deepEqual(errors, []);
  console.log('Camera layout checks passed: portrait/landscape rotation, proportional digital enlargement to 1080p, return to direct camera, circular pixels, responsive preview and track cleanup.');
  await context.close();
} finally { await browser.close(); }
