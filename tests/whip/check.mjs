// Isolate the moving-video test from the user's camera stream and deployed service.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const binary = process.env.GO2RTC_BINARY;
if (!binary) throw new Error('Set GO2RTC_BINARY to a native go2rtc 1.9.14 executable.');
const temporary = await mkdtemp(join(tmpdir(), 'camera-whip-'));
const config = join(temporary, 'go2rtc.yaml');
await writeFile(config, `api:\n  listen: "127.0.0.1:11984"\n  allow_paths: ["/api/webrtc"]\nrtsp:\n  listen: "127.0.0.1:18554"\nwebrtc:\n  listen: "127.0.0.1:18555"\n  candidates: ["127.0.0.1:18555"]\n  ice_servers: []\n  filters:\n    loopback: true\nstreams:\n  stability: []\nlog:\n  format: text\n  level: warn\n`);
const server = spawn(resolve(binary), ['-config', config], { stdio: ['ignore', 'inherit', 'inherit'] });
const closed = new Promise(resolve => server.once('exit', resolve));
try {
  const deadline = Date.now() + 10000;
  while (true) {
    try { await fetch('http://127.0.0.1:11984/api/webrtc'); break; }
    catch (error) { if (server.exitCode !== null || Date.now() > deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const child = spawn('go', ['run', '-buildvcs=false', '.', '-endpoint', 'http://127.0.0.1:11984/api/webrtc?dst=stability',
    '-rtsp', 'rtsp://127.0.0.1:18554/stability', '-seconds', process.env.STABILITY_SECONDS || '60'],
    { cwd: new URL('.', import.meta.url), stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`WHIP check exited ${code}`)));
  });
} finally {
  server.kill('SIGTERM'); await closed;
  await rm(temporary, { recursive: true, force: true });
}
