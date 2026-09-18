# Camera → RTSP

go2rtc is the Go backend. It serves a small website that asks for camera permission, publishes **video only** over WebRTC, and exposes the result through RTSP. Zoom changes the transmitted video, using camera-native zoom when available and 1x–4x digital enlargement otherwise.

Capture prefers the rear camera on phones and falls back to an available camera on devices without one. It requests **1920x1080 at up to 30 fps**, allowing lower resolutions/frame rates when the device cannot provide that target. At 1x, smaller camera images retain their original size. When software zoom is used, the site requests up to 3840x2160 capture if the camera advertises higher-resolution capability, returning to the 1080p capture request at 1x. The browser may still deliver a smaller source; the measured camera dimensions are shown. A 2x crop from actual 4K input can retain 1080p source detail. Digital zoom enlarges the selected field of view to an output of up to 1920x1080 landscape or 1080x1920 portrait, using high-quality canvas interpolation where supported. Other proportions are preserved (for example, 640x480 input becomes 1440x1080 at digital zoom). The preview displays the output resolution and adapts to its aspect ratio, including dimension changes after phone rotation.

Digital zoom necessarily selects a smaller field of view and enlarges it; interpolation cannot recover missing detail or provide optical lens zoom. Native camera controls are preferred where available, but native zoom may itself be digital and does not guarantee optical lens switching. Firefox Android currently has an [open missing camera zoom capability issue](https://bugzilla.mozilla.org/show_bug.cgi?id=1988104). Try current Chrome on Android for exposed camera controls; support on the actual phone still needs verification. Browsers do not expose every lens switch or computational enhancement found in a phone's camera app.

WebRTC allows up to **12 Mbps** and **30 fps**, with no requested resolution downscaling. Where supported, the encoder prioritizes maintaining resolution under congestion. These are ceilings/preferences, not guaranteed network throughput or delivered fps; the camera, browser encoder, device load and connection determine actual quality. Optional Chromium codec hints request a 6 Mbps starting bitrate without a minimum; other browsers may ignore these hints. Track content hints prioritize image detail. The quality row shows actual encoded dimensions, measured fps/bitrate, media transport and reported CPU/network limits. go2rtc relays the resulting H.264 stream without re-encoding it.

### Transmission processing

- Unmodified 1x and supported native zoom send the raw camera track directly to WebRTC, avoiding a canvas frame copy and redraw loop. Oversized sources are proportionally downscaled when canvas capture is supported.
- The digital renderer starts only when needed. It follows new camera frames using `requestVideoFrameCallback`; older browsers use a 30 Hz fallback that skips duplicate media timestamps. A timestamp watchdog resumes rendering if frame callbacks stop. Browsers without the canvas high-quality setting (including Firefox) use a GPU Catmull-Rom bicubic interpolator when WebGL is available, with ordinary canvas interpolation as fallback. This is interpolation, not AI detail reconstruction. Rendering/capture is limited to approximately/up to 30 fps.
- `RTCRtpSender.replaceTrack` switches between raw and enlarged tracks within the same publishing session; returning to 1x stops the canvas track and renderer. If the browser rejects a switch, the old stream remains active and the page reports the failure.
- H.264 codec preferences retain offered RTX/RED/FEC repair codecs for negotiation rather than removing all loss-recovery options. Their use depends on the peer's answer. go2rtc continues to bridge the encoded stream directly to RTSP.

The camera upload defaults to ICE TCP to reduce loss/reordering on the media bridge, accepting additional latency under congestion. Set `mediaTransport` to `auto` in `web/config.json` for automatic UDP/TCP selection or TURN deployments. TCP port 8555 must be reachable. Temporary disconnections retain the camera; failed/stalled connections rebuild the WHIP peer with bounded retries and backoff. The site requests a screen wake lock when available; keep the page visible and the phone unlocked. RTSP clients may need to reopen the stream after a publishing session is rebuilt.

For a reliable RTSP viewer connection, use TCP (`ffplay -rtsp_transport tcp ...`). TCP/UDP 8555 still needs to be reachable for the browser-to-go2rtc connection. No server-side FFmpeg/transcoding process is added to the runtime path.

The site requests **continuous autofocus and automatic exposure** on the raw camera track when the browser advertises those modes. It checks `getSettings()` afterward and displays the reported result below zoom. Unsupported controls remain camera managed; rejected or silently ignored requests are shown explicitly. No manual focus distance, exposure time or ISO is set. Native zoom preserves capture constraints and rechecks/restores the automatic modes if the driver resets them. Chromium's separate image-control constraint path is handled without discarding resolution/frame-rate settings.

Automatic mode confirmation verifies the browser-reported mode, not optical performance. To check your phone, alternate between near and distant subjects, change the lighting, and repeat after native zoom while watching both the preview and RTSP output. Focus should settle and exposure should adapt. A fixed-focus camera cannot gain autofocus through software; browsers that do not expose these controls cannot confirm them. Low light can still reduce actual camera fps or image quality.

## Start locally

```sh
docker compose up -d
```

Open **http://localhost:1984**, press **Start camera**, and allow camera access. Open this address in VLC:

```text
rtsp://localhost:8554/camera
```

Or play it with FFplay:

```sh
ffplay -rtsp_transport tcp rtsp://localhost:8554/camera
```

For VLC, use a 1000 ms network buffer and explicit TCP, for example:

```sh
vlc --rtsp-tcp --network-caching=1000 rtsp://localhost:8554/camera
```

Increase caching to 2000 ms if Wi-Fi delivery is uneven. Buffering absorbs timing variation but cannot keep a suspended camera or broken publisher alive.

Move the zoom slider and watch the RTSP image change. **Stop** closes the camera, canvas capture, WebRTC peer and go2rtc's WHIP resource. Leaving the page also attempts cleanup. Keep the capture page open and in the foreground; browsers can throttle or suspend capture in background tabs or on locked devices.

This is a **shared single-camera installation**. Use one publishing tab/device at a time. go2rtc can accept multiple publishers into the same destination; this setup does not enforce account isolation or a publisher limit. The fixed RTSP address continues to identify this camera between publishing sessions.

## Use a native go2rtc binary

Download **v1.9.14** for your platform from the [official releases](https://github.com/AlexxIT/go2rtc/releases/tag/v1.9.14). Run from this project directory:

```sh
go2rtc -config go2rtc.yaml
```

The native config listens on loopback by default. Docker listens inside the container and publishes the same ports on host loopback. No separate Go service, database, FFmpeg process or Node runtime is required to run the website.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `BIND_HOST` | `127.0.0.1` | Host address for Docker's published ports |
| `WEBRTC_HOST` | `127.0.0.1` | Reachable IP/DNS name advertised for WebRTC media |
| `API_LISTEN` | `127.0.0.1:1984` | Native website/signaling listener; Compose sets `:1984` |
| `RTSP_LISTEN` | `127.0.0.1:8554` | Native RTSP listener; Compose sets `:8554` |
| `WEBRTC_LISTEN` | `127.0.0.1:8555` | Native WebRTC TCP/UDP listener; Compose sets `:8555` |

For Compose overrides, copy `.env.example` to `.env` and edit it. Compose provides its variables to the container explicitly; a native go2rtc invocation needs exported environment variables.

`web/config.json` controls the page's destination stream, displayed RTSP hostname/port, and browser ICE servers. A null `rtspHost` uses the website hostname. If your website and RTSP server have different names, set the RTSP hostname explicitly. If you rename `camera`, update both `go2rtc.yaml` and `web/config.json`.

The backend's HTTP allowlist registers only the static website and `/api/webrtc`. Configuration editing, stream mutation, shell/FFmpeg and process-control APIs are not registered. `web` contains only public assets; do not put secrets there.

## Remote/LAN use

Camera access requires **HTTPS** except on localhost. Serving `http://192.168.x.x:1984` alone will not enable the camera.

### Local HTTPS without a domain

With `BIND_HOST` and `WEBRTC_HOST` set to your server's LAN IPv4 in `.env`, generate a local certificate and start the HTTPS overlay:

```sh
sh scripts/setup-https.sh 192.168.50.127
docker compose -f compose.yaml -f compose.https.yaml up -d
```

On the device whose camera you want to capture, download the **public CA certificate** from `http://192.168.50.127:1984/camera-ca.crt` (or copy `tls/ca.crt` directly). Confirm its SHA-256 fingerprint matches the setup script's output, then install it as a trusted certificate authority. On Windows, use Current User → Trusted Root Certification Authorities; on macOS, import into Keychain Access and set the CA to Always Trust. Firefox may require importing the CA into its own Authorities store. Mobile devices also need CA installation; iOS requires enabling full trust under Certificate Trust Settings after installing the profile.

Restart the browser and open **https://192.168.50.127:8443/**. The page must open without a certificate warning. Clicking through an untrusted certificate warning is not a substitute for installing the CA. Allow TCP **8443**, and retain TCP/UDP **8555** for WebRTC. RTSP remains on TCP **8554**.

Replace the example IP everywhere with your server's actual LAN IP. The certificate is valid for that IP, `127.0.0.1`, and `localhost`; if the LAN IP changes, rerun the script and recreate the container. Keep `tls/ca.key` private on the server. Only the public CA certificate belongs on the capturing device. Remove the CA from client trust when this local setup is no longer needed. A public domain with a publicly trusted certificate, or Tailscale Serve for devices on the same tailnet, avoids manual CA installation.

Use both Compose files for later updates/recreates; using only `compose.yaml` removes the HTTPS overlay. Native go2rtc can use the generated files with `API_TLS_LISTEN=192.168.50.127:8443 go2rtc -config go2rtc.yaml` and appropriately exported media listeners/candidates.

### Other remote deployments

For example, for a server at `192.168.1.50`:

1. Set `WEBRTC_HOST=192.168.1.50` and make TCP/UDP **8555** reachable from the capturing device. If using Docker outside a localhost tunnel, set `BIND_HOST` to the host's LAN IP. For native use, change the listener addresses to that IP.
2. Serve the website/signaling over trusted HTTPS. Use go2rtc's `api.tls_listen`, `api.tls_cert`, and `api.tls_key`, or reverse-proxy the local HTTP listener. The page expects the website at the URL root, not a subdirectory.
3. Before exposing the HTTP listener to other users, configure `api.username`, `api.password`, and **`api.local_auth: true`**. The latter also authenticates requests from a local reverse proxy. Retain the HTTP route allowlist. Use HTTPS for these credentials.
4. If exposing RTSP outside a trusted network, configure its separate `rtsp.username` and `rtsp.password`, or keep the RTSP listener behind a VPN/SSH tunnel. Website authentication does not authenticate RTSP clients. Do not expose go2rtc's unrestricted management APIs.

An HTTPS reverse proxy carries SDP signaling; media still connects to go2rtc's WebRTC port. Restrictive NAT may require TURN. Add your TURN server under `webrtc.ice_servers` in `go2rtc.yaml` and corresponding browser ICE configuration in `web/config.json`. Browser TURN credentials are visible to visitors; use restricted/short-lived credentials. See the [go2rtc WebRTC configuration](https://github.com/AlexxIT/go2rtc/blob/v1.9.14/internal/webrtc/README.md).

For local RTSP access to a remote loopback-bound server:

```sh
ssh -L 8554:127.0.0.1:8554 user@server
ffplay -rtsp_transport tcp rtsp://localhost:8554/camera
```

**H.264 WebRTC encoding is required by this page.** go2rtc's WebRTC ingest does not accept VP8/VP9/AV1; a browser build without an H.264 encoder receives a compatibility error before camera capture. Some Linux/ARM Chromium builds lack H.264. Use a browser build with H.264 enabled, such as an appropriate Chrome/Safari installation. go2rtc bridges protocols without transcoding. Native zoom depends on the camera, browser and PTZ permission. Digital zoom reduces image detail.

## HTTP/media contract

- `POST /api/webrtc?dst=camera`: browser sends a complete SDP offer as `application/sdp`; go2rtc replies `201`, an SDP answer, and a relative `Location: webrtc?id=...`.
- `DELETE /api/webrtc?id=<session>`: tears down that publishing peer; already-closed peers may return `404`.
- `GET /`: camera page and static assets, including public `config.json`.
- `rtsp://<host>:8554/camera`: RTSP output while a camera is publishing.

This uses go2rtc's existing API directly. There is no custom session API or health endpoint. Session resource IDs are provided by go2rtc, not custom authentication credentials. The page validates the returned Location, bounds ICE/signaling waits, stops local media even if cleanup fails, and consumes/deletes late session responses after cancellation. go2rtc handles peer disconnections when browser cleanup cannot reach it. Accounts, recording, audio, transcoding and multi-camera provisioning are outside this starter's scope.

## Verification

Unit tests need Node 20+ and no installed packages:

```sh
npm test
node --check web/app.mjs
node --check web/media.mjs
docker compose config --quiet
```

For browser integration, start go2rtc first, install the development browser dependency and ensure FFmpeg is on PATH:

```sh
npm install
npx playwright install chromium
npm run test:browser
```

With H.264 available, the browser check uses a generated color-bar camera, decodes actual RTSP frames before/after 2x zoom, and checks Stop/restart. In a build without H.264, it verifies the compatibility error and real outgoing canvas capture/zoom, and explicitly reports the browser-to-RTSP portion as skipped. Both paths check denied permission, mobile layout and disabled management routes. Screenshots go to ignored `test-results/`. Optional variables: `CAMERA_URL`, `CAMERA_RTSP`, `CHROMIUM_PATH`, and `PLAYWRIGHT_MODULE` (an installed Playwright module path).

`npm run test:layout` checks rear-camera constraints, actual portrait/landscape canvas capture and rotation, circular pixels before/after zoom, responsive preview proportions, and cleanup. It does not use a physical camera. For testing a local HTTPS CA not installed in the automated browser only, set `CAMERA_ALLOW_UNTRUSTED_TLS=1`; actual users must install certificate trust.

Separately verify go2rtc's H.264 RTSP relay with a synthetic FFmpeg publisher (run without any camera publishing):

```sh
npm run test:backend
```

`npm run test:transmission` checks real browser encoded/decoded 1080p frame progress, the digital renderer watchdog, peer recovery without reacquiring the camera, retained zoom and cleanup. It uses local test signaling and VP8 when H.264 is unavailable; no physical camera or go2rtc stream is touched. `TEST_BICUBIC=1 npm run test:layout` exercises the Firefox interpolation compatibility path and checks actual enlarged pixels and orientation.

With Go 1.24+ and FFmpeg available, run the sustained H.264 WHIP → go2rtc → RTSP check on isolated local ports:

```sh
GO2RTC_BINARY=/path/to/go2rtc npm run test:whip
```

The test builds a test-only Go/Pion publisher, streams moving 1080p/30 H.264 over ICE TCP and asserts 60 seconds of distinct decoded frames with bounded gaps. It does not measure the phone's browser encoder. These Go dependencies are not runtime website dependencies.

For hardware verification, grant permission to a physical camera, open RTSP in VLC, check that zoom changes the player's image, and press Stop to verify the browser's camera indicator turns off. Test camera-native zoom with a compatible camera; automated checks use digital zoom and mocked native constraints.
