# Verification and deployment scope

## Executed checks

- Unit suite: 18 tests covering crop geometry, native zoom/fallback, video-only capture, cleanup, cancellation, WHIP Location validation, HTTP failures and rejected video codecs.
- JavaScript syntax checks and `docker compose config --quiet`.
- Live go2rtc 1.9.14 native binary: website and assets served; configuration, stream mutation, FFmpeg, exit and restart routes return 404.
- Chromium synthetic camera: outgoing canvas capture, 2x crop changes in actual video pixels, output track termination, denied permission handling, unsupported-codec error and mobile layout.
- Live FFmpeg publisher → go2rtc → FFmpeg/FFprobe: 1280x720 H.264 RTSP metadata and decoded color-bar video frame verified.

The environment's cached Linux/ARM Chromium does not expose H.264 encoding. Its offered codecs are VP8, VP9 and AV1. go2rtc's response rejected that video m-line (`m=video 0`), so the full browser-WebRTC-to-RTSP portion could not be verified here. The page now reports that incompatibility immediately instead of waiting for a connection timeout. `tests/browser.mjs` executes the full RTSP/zoom check when H.264 is available and clearly reports its skip otherwise.

Physical-camera/PTZ zoom, capture from a second physical device, and NAT traversal remain untested. The original media checks used the pinned native binary; the subsequent LAN checks below used the deployed Docker service.

## LAN HTTPS checks (2026-09-17)

- The Docker service was initially bound to 127.0.0.1. It now runs on the server's LAN address, 192.168.50.127, with website HTTP 1984, HTTPS 8443, RTSP 8554, and WebRTC TCP/UDP 8555.
- `docker compose -f compose.yaml -f compose.https.yaml config --quiet` passed, and the recreated Docker service started successfully.
- OpenSSL verified the server certificate against the generated CA and the LAN IP. The setup script rejected an invalid IPv4 address. Private keys remain outside the static directory and are ignored by version control; only the server certificate/key are mounted into the container.
- HTTPS returned HTTP 200 with curl certificate verification enabled using `--cacert tls/ca.crt`. The downloaded public CA certificate matched the generated file.
- Chromium rejected the HTTPS origin before trusting its local CA. With a test-only certificate override, the page was a secure context, synthetic video capture succeeded, and captured tracks stopped. Plain LAN HTTP was an insecure context. This test override does not install trust on the user's device.
- Private-key paths and the management API returned 404 over HTTPS. The existing 18 unit tests passed.

The visiting device still needs to install the local CA in its trust store. Real client trust installation and end-to-end H.264 publishing from that device have not been verified. To retain HTTPS, subsequent Compose updates must include both Compose files.

## Rear camera and proportional video checks (2026-09-17)

- The unit suite now passes 21 tests, including rear-camera preference, portrait video with landscape track settings, and rotation while zoomed.
- `tests/camera-layout.mjs` exercised actual canvas capture with a circular image on the running HTTPS Docker site. Portrait 720x1280 and landscape 1280x720 output kept the image circular at 1x/2x zoom. The preview container matched the video's dimensions on mobile and desktop, without horizontal overflow. Resolution labels updated on rotation, tracks stopped, and no page errors occurred.
- The test used synthetic video and a test-only local certificate override. Physical rear-camera selection and publishing from the user's device remain unverified.

## 1080p/30 quality checks (2026-09-17)

- Unit suite: 23 tests passed, including proportional 1080p output bounds for landscape, portrait and 4:3 input, no upscaling, 8 Mbps/30 fps sender ceilings, and graceful fallback when optional sender tuning is rejected.
- The Chromium synthetic camera fixture was raised to 1920x1080 at 30 fps. Its actual decoded preview dimensions and camera track frame rate were asserted as 1920x1080 and 30. Real outgoing canvas capture, 2x zoom, mobile layout and denied permission checks passed.
- The layout test used 1080x1920 portrait and 1920x1080 landscape capture, preserving circular pixels at 1x/2x and updating preview dimensions after rotation.
- JavaScript syntax checks passed. The cached browser still lacks an H.264 encoder, so the complete browser-to-go2rtc-to-RTSP quality path remains unverified here. Delivered physical-camera fps and network bitrate depend on the user's device and connection; the configured ceilings are not guarantees.

## Automatic focus and exposure checks (2026-09-17)

- 31 unit tests passed. Added coverage for supported continuous modes, independent control failures, silent ignores, cross-control resets, unsupported/fixed-focus modes, quality and auto-mode preservation/restoration after native zoom, Chromium's mixed-constraint fallback, and cancellation during autofocus setup.
- The browser check used a real synthetic camera and WebRTC offer with signaling held locally, then checked the displayed statuses against actual raw track settings. This fixture exposes no autofocus/exposure controls; the UI correctly reported camera managed/not confirmed. 1920x1080/30 fps capture settings were retained, Stop ended the raw track, and late signaling was cleaned up. Existing canvas capture/zoom, denied permission, and mobile checks passed.
- Continuous control application/restoration is verified with capability-aware mocks; actual hardware lens focusing and automatic brightness response have not been verified. The README supplies physical near/far subject, lighting, native-zoom and RTSP checks. A browser-reported continuous mode is not proof of optical performance.

## Zoom enlargement and transmission checks (2026-09-17)

- 38 unit tests passed, including direct camera output at 1x/native zoom, lazy proportional digital enlargement with high-quality interpolation, frame callback throttling, duplicate timestamp skipping, sender replacement within the same WHIP session, failed-switch rollback, cancellation and renderer cleanup. Tests show no frame draws on the direct path; no throughput, latency or device CPU improvement has been benchmarked.
- Real Chromium sender-track checks passed with signaling held locally: zoom 2x replaced the raw camera track with the enlarged track shown in the preview; returning to 1x restored the original sender track and ended the canvas track. Camera capture retained 1920x1080/30 settings. This checks browser track switching, not H.264 delivery through go2rtc.
- The HTTPS layout test passed portrait/landscape rotation, circular pixels, responsive dimensions and track cleanup. A 640x480 source remained at its native size at 1x, enlarged proportionally to 1440x1080 at 2x, then returned to direct 640x480 output. The test waits for painted image content after source canvas resizing, because a resize clears the fixture before its next frame.
- A live FFmpeg H.264 publisher through the deployed go2rtc service produced verified 1920x1080 RTSP metadata and a decoded color-bar frame. This isolates the RTSP relay from the browser publisher.
- JavaScript syntax checks passed. The browser compatibility, denied permission and management-route checks passed. The cached Chromium still lacks an H.264 encoder, so the complete browser-to-WebRTC-to-RTSP zoom path remains unverified. Physical lens zoom, actual autofocus/exposure response and delivered hardware frame rate remain device checks.

## Source security review

Scope: this installation's configuration, browser capture/signaling/cleanup and static assets. Review did not audit go2rtc's entire upstream codebase.

No unresolved high-severity finding was identified within the local deployment scope. Controls checked:

- `go2rtc.yaml`: native listeners default to loopback; only `/` and `/api/webrtc` are registered. Static root is `web`, not the project/configuration directory.
- `compose.yaml`: published ports default to loopback; website and configuration mounts are read-only.
- `web/media.mjs`: returned WHIP resources must match the signaling origin/path, contain a single bounded ID and no credentials, fragment or extra parameters. HTTP redirects are rejected. No caller-selected upstream URL or shell execution is implemented.
- `web/app.mjs`: configuration/status/address data is written through text/value properties; no untrusted HTML is inserted. Camera permission follows Start; microphone capture is disabled.
- Startup/Stop failure paths release local media and peers even when the upstream DELETE fails. Late publishing resources are deleted after cancellation.

Intentional limitations: this is a shared camera, not an account-isolated application. go2rtc's WHIP IDs are resource identifiers, not authentication credentials. Default localhost use has no authentication. Remote use requires HTTPS, website authentication with `local_auth: true`, and a separate policy for RTSP viewers. The README documents these actual deployment requirements; do not infer account isolation or request/session-rate limits from this starter.
