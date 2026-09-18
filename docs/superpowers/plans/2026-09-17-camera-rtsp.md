# go2rtc Camera Website Implementation Plan

**Execution:** Direct implementation authorized by the user. Use go2rtc directly as the Go backend per their latest instruction.

**Interfaces/files:** `go2rtc.yaml` defines an empty `camera` stream, static root and route allowlist. `compose.yaml` pins go2rtc and maps local ports. `web/media.mjs` exports crop/Location helpers, CameraSource and Publisher; `web/app.mjs` binds controls and lifecycle. `tests/media.test.mjs` uses Node built-in tests. `README.md` documents native/Compose deployment and HTTP/media contracts.

1. Implement geometry and validate go2rtc's relative `webrtc?id=...` resource without accepting arbitrary URLs.
2. Implement native zoom with actual outgoing canvas crop fallback and cleanup.
3. Implement send-only WebRTC/WHIP, bounded waits, cancellation, DELETE and error messages.
4. Add page and pinned deployment with management routes disabled.
5. Run `node --test tests/*.test.mjs`, JS syntax checks and `docker compose config --quiet`.
6. Smoke-test live go2rtc and synthetic browser publishing where available; document hardware verification limits.

## LAN HTTPS correction

Use go2rtc's native TLS listener on TCP 8443 through an optional Compose overlay. Generate a persistent local CA and a server certificate with the LAN IPv4 SAN using OpenSSL. Mount only the server certificate/key; expose only the public CA certificate for client installation. Keep private keys outside the static directory and ignored by version control. Validate IPv4 inputs, certificate chain/IP, merged Compose config, live authenticated TLS responses, and browser camera availability on the HTTPS origin. Client certificate trust must be installed on the user's visiting device.

## Rear camera and video proportions

Prefer the rear camera without mandatory device constraints or landscape dimensions. Match canvas dimensions to decoded video frames, including rotation, and drive preview aspect ratio from metadata/resize events. Verify regressions for rear-camera preference, portrait frames with inconsistent track settings, and rotation while zoomed. Check real canvas capture and responsive layout in Chromium; physical rear-camera selection remains a device check.

## 1080p/30 quality

Request 1920x1080 at ideal/max 30 fps; preserve the rear-camera preference and actual frame proportions. Bound canvas output to 1080p in either orientation, without upscaling. Configure WebRTC for an 8 Mbps bitrate ceiling, 30 fps ceiling and no requested downscaling, with optional maintain-resolution preference. Verify lower-resolution preservation, larger landscape/portrait/4:3 bounds, sender settings and unsupported tuning fallback. Use a 1920x1080 synthetic browser camera at 30 fps and full-HD portrait/rotation layout checks. Retain the environment's H.264 end-to-end testing limitation.

## Automatic focus and exposure

Independently request continuous focus/exposure where track capabilities expose them, read back actual modes and display honest statuses. Preserve quality and existing controls when changing native zoom, then recheck/reapply auto modes. Handle Chromium's rejection of mixed image/core constraints using its image-only path, which retains core constraints. Test supported, rejected, ignored and unsupported modes, cross-control resets, zoom preservation and startup cancellation. Verify synthetic browser capture and reported modes; actual lens/exposure convergence requires a physical device check.

## Zoom enlargement and transmission efficiency

Prefer native zoom, and digitally enlarge to proportional full-HD output with high-quality interpolation when necessary. Explain that digital enlargement still selects/crops a smaller source field and cannot provide optical detail. Bypass canvas for raw 1x/native-zoom output; create the renderer lazily and replace the WebRTC sender track without starting another WHIP session. Return to raw/stop rendering at 1x. Drive processing from video-frame callbacks and deduplicate older-browser interval fallback. Preserve offered H.264 repair codecs. Verify rollback and cancellation during switching, renderer cleanup, real sender track replacement, low-resolution enlargement, rotation/proportions, and a live 1080p H.264 RTSP relay. Keep H.264 browser end-to-end and physical hardware limitations explicit.
