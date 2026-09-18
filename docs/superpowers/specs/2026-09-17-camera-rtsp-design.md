# Browser Camera to RTSP with go2rtc

The user approved implementation, accepts latency, and requested using go2rtc directly as the backend. This revision supersedes the earlier MediaMTX/custom-Go-wrapper design.

## Architecture

go2rtc 1.9.14, written in Go, serves the custom website via `api.static_dir`, accepts browser video through `POST /api/webrtc?dst=camera`, and serves it at `rtsp://<host>:8554/camera`. Configure an empty `camera` destination. Disable config, stream-mutation, FFmpeg and process-control HTTP routes with `api.allow_paths`. Complete ICE gathering before SDP POST; WHIP PATCH is unsupported. Validate the same-origin relative WHIP Location before DELETE. Prefer H.264 for RTSP playback; no transcoding.

## Camera and zoom

Start explicitly requests camera permission and video only. Provide Start/Stop, outgoing preview, zoom, status and copyable RTSP URL. Native camera zoom uses capabilities and constraints. Digital fallback selects a centered field of view and enlarges it to the full output frame at 1x–4x, with high-quality interpolation where supported. Digital enlargement cannot supply optical detail or every lens/computational feature of a phone camera app. Preview the published track. Disable zoom explicitly when neither mechanism is available. Stop/failures release tracks, rendering timers, peer connections and WHIP sessions. Handle cancellation during permission and negotiation; bound ICE/HTTP waits; attempt keepalive cleanup on page exit.

Rear-camera capture is preferred with an ideal environment-facing constraint, allowing desktop cameras to remain usable. Request 1920x1080 with frame rate ideal/max 30, allowing lower-quality devices and without a mandatory aspect ratio. Cap the outgoing canvas proportionally to 1920x1080 landscape or 1080x1920 portrait. Preserve smaller inputs at 1x, and permit enlargement toward these bounds during digital zoom. Recompute its size from decoded video dimensions on each frame so rotation cannot stretch the image. Match the responsive preview container to the outgoing video's current aspect ratio and display its resolution. Keep zoom center-cropping in the same proportions. Set WebRTC encoding ceilings to 12 Mbps/30 fps and resolution scaling to 1; request maintain-resolution degradation preference where supported, with graceful fallback if sender tuning is rejected. Targets do not guarantee delivered quality.

Send raw camera tracks directly at 1x and for supported native zoom, except when an oversized source needs proportional downscaling. Start the digital renderer lazily, following new video frames through requestVideoFrameCallback with a 30 fps render ceiling; older browsers use a timer that skips duplicate media timestamps. Switch the sender with replaceTrack within the existing WHIP session and restore raw output/stop rendering at 1x. A rejected switch preserves the previous published output. Keep offered H.264 repair codecs in negotiation where available; actual use depends on go2rtc's answer. Relay the encoded stream directly to RTSP without a server transcoding process.

## Stream reliability and Firefox enlargement

Default publishing transport is ICE TCP, selected from the validated go2rtc SDP answer. Automatic UDP/TCP remains configurable. Retain the camera across disconnections and rebuild the peer/WHIP session with bounded retry and backoff; detect stalled outbound frame encoding and peers closed without a state-change event through measured WebRTC stats. Stop cancels retry/polling and deletes late sessions. Show actual encoded dimensions/fps/bitrate and network/CPU limitation reports. Request a screen wake lock where supported; background capture remains browser controlled.

For digital zoom, opportunistically request up to 4K source capture when higher-resolution capability is advertised, retaining 1080p output bounds and returning to the original quality request at 1x. Use separate core capture constraints and recheck autofocus/exposure. For browsers lacking canvas quality control, use a WebGL Catmull-Rom bicubic interpolation path and release GPU resources with the renderer; fall back to ordinary canvas if WebGL is unavailable. A timestamp watchdog renders new frames when video callbacks stall. This does not imply optical lens switching or AI enhancement.

## Automatic focus and exposure

On the raw camera track, independently request continuous focus and exposure only when advertised by getCapabilities. Confirm modes using getSettings and show continuous, camera managed/not confirmed, unavailable, ignored/unconfirmed, or rejected statuses without claiming physical optical performance. Keep capture working if optional controls fail. Preserve the current capture/control constraints for native zoom; recheck and restore auto modes afterward. For Chromium's known mixed image/core constraint error, retry image controls through its separate path, preserving existing core capture constraints. Stop/cancellation releases tracks even during control setup. Do not set manual focus distance, ISO or exposure time.

## Deployment and scope

Provide local/native and pinned Docker Compose setup. Bind published ports to loopback by default. Localhost HTTP supports camera capture; remote use requires HTTPS and reachable WebRTC TCP/UDP port 8555. Document candidate hosts, TURN and RTSP codec support. An HTTP proxy handles signaling, not media. This is a shared single-camera installation: use one active publisher. No account isolation, custom ownership tokens or publisher-count enforcement is claimed. No audio, recording, transcoding or dynamic multi-camera sessions.

## Verification

Node built-in tests cover crop geometry, native fallback, track/timer cleanup, safe WHIP resources, failed negotiation and cancellation. Validate Compose and live go2rtc asset serving, stream configuration and blocked management routes. Run synthetic-camera browser-to-RTSP and digital zoom checks where possible. Report physical-camera/native hardware zoom checks separately.
