// Live H.264 relay test. Requires running go2rtc and FFmpeg/FFprobe on PATH.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const rtsp = process.env.CAMERA_RTSP || 'rtsp://127.0.0.1:8554/camera';
const producer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-re', '-f', 'lavfi',
  '-i', 'smptebars=size=1920x1080:rate=30', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-f', 'rtsp', '-rtsp_transport', 'tcp', rtsp],
  { stdio: ['ignore', 'ignore', 'pipe'] });
const finished = new Promise(resolve => producer.on('exit', resolve));
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('H.264 producer startup timed out.')), 10000);
    let log = '';
    producer.on('error', error => { clearTimeout(timer); reject(error); });
    producer.on('exit', code => { clearTimeout(timer); reject(new Error(`Producer exited (${code}): ${log}`)); });
    producer.stderr.on('data', data => {
      log = (log + data.toString()).slice(-4000);
      if (log.includes('frame=')) { clearTimeout(timer); resolve(); }
    });
  });
  const { stdout: metadata } = await run('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp',
    '-show_entries', 'stream=codec_name,width,height', '-of', 'json', rtsp], { timeout: 15000 });
  const video = JSON.parse(metadata).streams[0];
  assert.deepEqual(video, { codec_name: 'h264', width: 1920, height: 1080 });
  const { stdout: frame } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp', '-i', rtsp, '-frames:v', '1', '-vf', 'scale=64:36',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', timeout: 15000 });
  assert.equal(frame.length, 64 * 36 * 3);
  const position = (10 * 64 + 2) * 3;
  const gray = [...frame.subarray(position, position + 3)];
  assert.ok(gray.every(value => value > 150 && value < 220), `Expected color-bar gray, got ${gray}`);
  console.log('Backend check passed: go2rtc receives and relays decodable 1920x1080 H.264 over RTSP.');
} finally {
  producer.kill('SIGTERM');
  await finished;
}
